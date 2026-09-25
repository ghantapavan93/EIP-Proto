import { afterEach, describe, expect, it } from 'vitest';
import { mockRequest } from '../mocks/server';
import { SAMPLES, sandboxModel } from '../mocks/sandbox';
import type { ApiError } from '../api/errors';
import type { AuditOut, MeOut, Page, SandboxArtifactOut, SandboxSamplesOut, SandboxTranscriptOut, TestCaseOut } from '../api/types';

const reviewer = { username: 'reviewer', password: 'reviewer' };
const engineer = { username: 'engineer', password: 'engineer' };

describe('mock /me', () => {
  it('describes the reviewer as an analyst, with what they can and cannot do', async () => {
    const me = (await mockRequest('GET', '/me', undefined, reviewer)) as MeOut;
    expect(me).toMatchObject({ name: 'reviewer', role: 'analyst', role_label: 'QA Compliance Analyst' });
    expect(me.permissions.find((p) => p.action === 'start_runs')).toMatchObject({ allowed: false });
    expect(me.permissions.find((p) => p.action === 'use_sandbox')).toMatchObject({ allowed: true });
    expect(me.roles).toHaveLength(3);
    const eng = (await mockRequest('GET', '/me', undefined, engineer)) as MeOut;
    expect(eng.permissions.find((p) => p.action === 'start_runs')?.allowed).toBe(true);
  });
});

describe('mock sandbox', () => {
  afterEach(() => {
    sandboxModel.online = false;
    sandboxModel.latencyMs = 900;
  });

  it('serves samples for both tabs', async () => {
    const s = (await mockRequest('GET', '/sandbox/samples', undefined, reviewer)) as SandboxSamplesOut;
    expect(s.artifacts.length).toBeGreaterThanOrEqual(2);
    expect(s.transcripts.length).toBeGreaterThanOrEqual(1);
  });

  it('judges the same CY2024 script current on Sept 30 and stale on Oct 1, in every direction', async () => {
    const text = SAMPLES.artifacts[0].text;
    const before = (await mockRequest('POST', '/sandbox/artifact', { text, as_of: '2026-09-30' }, reviewer)) as SandboxArtifactOut;
    expect(before.summary.stale).toBe(0);
    expect(before.summary.current).toBe(before.summary.matches);
    const after = (await mockRequest('POST', '/sandbox/artifact', { text, as_of: '2026-10-01', label: 'script' }, reviewer)) as SandboxArtifactOut;
    expect(after.persisted).toBe(false);
    expect(after.text_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(after.summary.matches).toBeGreaterThanOrEqual(5);
    expect(after.summary.stale).toBe(after.summary.matches);
    expect(after.summary.over_restrictive).toBeGreaterThan(0);
    expect(after.summary.under_restrictive).toBeGreaterThan(0);
    expect(after.summary.reverify).toBeGreaterThan(0);
    for (const m of after.matches) expect(text).toContain(m.span);
    const soa = after.matches.find((m) => m.rule_code === 'soa-48h-wait');
    expect(soa).toMatchObject({ bound_version: 1, in_force_version: 2, verdict: 'stale', direction: 'over_restrictive', applies_from: '2026-10-01' });
  });

  it('says "ahead" for CY2027 wording checked before the flip', async () => {
    const out = (await mockRequest('POST', '/sandbox/artifact', { text: SAMPLES.artifacts[1].text, as_of: '2026-09-30' }, reviewer)) as SandboxArtifactOut;
    expect(out.matches.length).toBeGreaterThan(0);
    expect(out.matches.every((m) => m.verdict === 'ahead')).toBe(true);
  });

  it('redacts identifiers before matching and returns an honest empty result', async () => {
    const out = (await mockRequest('POST', '/sandbox/artifact', { text: 'Member 1EG4-TE5-MK73, SSN 123-45-6789, born 03/14/1957. Thanks for calling.' }, reviewer)) as SandboxArtifactOut;
    expect(out.redacted).toEqual({ medicare_number: 1, ssn: 1, dob: 1, phone: 0, email: 0, address: 0 });
    expect(out.matches).toEqual([]);
  });

  it('redacts contact details too — phone, email, street address — without mistaking an SSN for a phone', async () => {
    const text = 'Call Maria at (813) 555-0142 or 727.555.0199, email maria.l@example.com, mail 4120 Bayshore Blvd. SSN 123-45-6789.';
    const out = (await mockRequest('POST', '/sandbox/artifact', { text }, reviewer)) as SandboxArtifactOut;
    expect(out.redacted).toMatchObject({ phone: 2, email: 1, address: 1, ssn: 1 });
  });

  it('refuses empty (422) and oversize (413) text, and only the hash reaches the audit log', async () => {
    const empty = await mockRequest('POST', '/sandbox/artifact', { text: '   ' }, reviewer).catch((e: unknown) => e);
    expect((empty as ApiError).status).toBe(422);
    const big = await mockRequest('POST', '/sandbox/artifact', { text: 'x'.repeat(20_001) }, reviewer).catch((e: unknown) => e);
    expect((big as ApiError).status).toBe(413);
    const audit = (await mockRequest('GET', '/audit?event_type=sandbox.artifact_checked', undefined, reviewer)) as Page<AuditOut>;
    expect(audit.items.length).toBeGreaterThan(0);
    for (const row of audit.items) expect(JSON.stringify(row.payload)).not.toContain('Scope of Appointment');
  });

  it('answers 409 when no local model is reachable, and NEEDS_LABEL rule verdicts when one is', async () => {
    const text = SAMPLES.transcripts[0].text;
    const offline = await mockRequest('POST', '/sandbox/transcript', { text }, reviewer).catch((e: unknown) => e);
    expect((offline as ApiError).status).toBe(409);
    sandboxModel.online = true;
    sandboxModel.latencyMs = 0;
    const out = (await mockRequest('POST', '/sandbox/transcript', { text, product_line: 'MA' }, reviewer)) as SandboxTranscriptOut;
    expect(out.route).toBe('BLOCK');
    expect(out.contracts.filter((c) => c.outcome === 'NEEDS_LABEL').map((c) => c.code)).toEqual(['C-TPMO-01', 'C-SOA-01', 'C-SUP-01']);
    expect(out.spans?.every((s) => s.verified)).toBe(true);
  });
});

describe('mock seeded test cases', () => {
  it('seeds one approved and one pending example, approved by a different person', async () => {
    const tcs = (await mockRequest('GET', '/test-cases', undefined, reviewer)) as TestCaseOut[];
    const seeded = tcs.filter((t) => t.expected.seeded_example === true);
    expect(seeded.map((t) => t.status).sort()).toEqual(['APPROVED', 'PENDING_APPROVAL']);
    const approved = seeded.find((t) => t.status === 'APPROVED');
    expect(approved?.approver).toBe('demo-seed:compliance-lead');
    expect(approved?.approver).not.toBe(approved?.created_by);
    const audit = (await mockRequest('GET', '/audit?actor=demo-seed:compliance-lead', undefined, reviewer)) as Page<AuditOut>;
    expect(audit.items[0]).toMatchObject({ event_type: 'test_case.approved', actor_role: 'demo-seed' });
  });
});
