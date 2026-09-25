import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearCredentials, setCredentials } from '../api/auth';
import { queryClient } from '../api/queryClient';
import { sandboxModel } from '../mocks/sandbox';
import { GUIDE_KEY } from '../lib/guide';

/**
 * The new surfaces against the in-memory mock API, signed in as the
 * reviewer (analyst): the sandbox, the identity popover and role explainer,
 * visible-but-refused controls, the seeded test cases and the Change
 * triggers guide.
 */

vi.stubEnv('VITE_MOCK', '1');
const { App } = await import('../App');

function open(path: string, user = 'reviewer') {
  setCredentials({ username: user, password: user });
  queryClient.clear();
  window.history.pushState({}, '', path);
  return render(<App />);
}

beforeEach(() => {
  window.localStorage.removeItem(GUIDE_KEY);
});
afterEach(() => {
  sandboxModel.online = false;
  sandboxModel.latencyMs = 900;
});
afterAll(() => clearCredentials());

describe('/try — artifact check', () => {
  it('runs a sample in one click and links every highlight to its finding', async () => {
    open('/try');
    fireEvent.click(await screen.findByRole('button', { name: 'Call script · CY2024 wording' }, { timeout: 8000 }));
    const spans = await screen.findAllByTestId('sandbox-span', {}, { timeout: 8000 });
    expect(spans.length).toBeGreaterThan(0);
    const findings = screen.getByRole('list', { name: 'Findings' });
    expect(within(findings).getAllByRole('listitem').length).toBeGreaterThanOrEqual(5);
    // the as-of date defaults to Oct 1, 2026 (when the CY2027 changes apply): CY2024 wording is stale
    expect(screen.getAllByText(/stale/i).length).toBeGreaterThan(0);

    // click a highlight → its finding becomes the current one
    fireEvent.click(spans[0]);
    await waitFor(() => expect(within(findings).getAllByRole('listitem').some((li) => li.getAttribute('aria-current') === 'true')).toBe(true));
    // the screen-reader summary is announced
    expect(screen.getByText(/^Checked as of 2026-10-01: \d+ matches, [1-9]\d* stale/)).toBeInTheDocument();
  }, 20000);

  it('re-runs the check when the date changes, so the result always matches the picker', async () => {
    open('/try');
    fireEvent.click(await screen.findByRole('button', { name: 'Call script · CY2024 wording' }, { timeout: 8000 }));
    await screen.findByText(/^Checked as of 2026-10-01/, {}, { timeout: 8000 });
    fireEvent.click(screen.getByRole('button', { name: '2026-09-30' }));
    expect(await screen.findByText(/^Checked as of 2026-09-30: \d+ matches, 0 stale/, {}, { timeout: 8000 })).toBeInTheDocument();
  }, 20000);

  it('re-checks as of Oct 1 with Ctrl+Enter and shows stale findings with directions', async () => {
    open('/try');
    fireEvent.click(await screen.findByRole('button', { name: '2026-10-01' }, { timeout: 8000 }));
    const box = screen.getByLabelText('Text to check');
    fireEvent.change(box, { target: { value: 'Agents must complete the Scope of Appointment at least 48 hours before the appointment.' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(await screen.findByText('Over-restrictive', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByText(/encodes v1 → in force v2/)).toBeInTheDocument();
    expect(screen.getByText(/42 CFR 422\.2264/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy findings as Markdown/ })).toBeInTheDocument();
    expect(screen.getAllByText(/only a SHA-256 of the text is logged/).length).toBeGreaterThan(0);
  }, 20000);

  it('is honest when nothing rule-bearing is found', async () => {
    open('/try');
    fireEvent.click(await screen.findByRole('button', { name: 'Welcome email · no rule language' }, { timeout: 8000 }));
    expect(await screen.findByText('No rule-bearing language found', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByText(/Backstop only flags text that encodes one of the \d+ versioned rules/)).toBeInTheDocument();
  }, 20000);

  it('blocks text over the limit before it is sent', async () => {
    open('/try');
    const box = await screen.findByLabelText('Text to check', {}, { timeout: 8000 });
    fireEvent.change(box, { target: { value: 'x'.repeat(20_001) } });
    expect(screen.getByRole('button', { name: /Analyze/ })).toBeDisabled();
    expect(screen.getByText(/too long for one check/)).toBeInTheDocument();
  }, 20000);
});

describe('/try — call transcript', () => {
  it('shows a calm offline card when no local model is reachable (409)', async () => {
    open('/try?tab=transcript');
    fireEvent.click(await screen.findByRole('button', { name: 'MA call · disclaimer after benefits' }, { timeout: 8000 }));
    fireEvent.click(screen.getByRole('button', { name: /Run on local model/ }));
    expect(await screen.findByText('The live model is offline right now', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open a recorded real-model call/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Use the artifact check instead/ }));
    expect(await screen.findByLabelText('Text to check')).toBeInTheDocument();
  }, 20000);

  it('shows progress, then contracts with NEEDS_LABEL explained', async () => {
    sandboxModel.online = true;
    sandboxModel.latencyMs = 300;
    open('/try?tab=transcript');
    fireEvent.click(await screen.findByRole('button', { name: 'MA call · disclaimer after benefits' }, { timeout: 8000 }));
    fireEvent.click(screen.getByRole('button', { name: /Run on local model/ }));
    expect(await screen.findByText('Running the call through the local model')).toBeInTheDocument();
    expect(document.documentElement.hasAttribute('data-live-busy')).toBe(true);
    expect(await screen.findByText(/that's the QA sample you'd add/, {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getAllByText('needs label')).toHaveLength(3);
    // the model's own answer is shown (not graded) under each label-dependent contract
    expect(screen.getAllByText(/^model says /).length).toBeGreaterThan(0);
    expect(screen.getByText('What the model extracted')).toBeInTheDocument();
    expect(document.documentElement.hasAttribute('data-live-busy')).toBe(false);
  }, 20000);
});

describe('roles and access', () => {
  it('opens the identity popover from the role chip and closes it on Esc, returning focus', async () => {
    open('/');
    const chip = await screen.findByRole('button', { name: /Signed in as reviewer, Analyst/ }, { timeout: 8000 });
    fireEvent.click(chip);
    const dialog = await screen.findByRole('dialog', { name: 'Your role and access' });
    expect(within(dialog).getByText(/Signed in as/)).toHaveTextContent('Signed in as reviewer · QA Compliance Analyst');
    const cant = within(dialog).getByRole('list', { name: "You can't" });
    expect(within(cant).getByText('Start a harness run')).toBeInTheDocument();
    expect(within(dialog).getByText('Engineers and admins can:')).toBeInTheDocument();
    expect(within(cant).getByText('Approve a test case (a different person from its creator)')).toBeInTheDocument();
    expect(within(cant).getByText('Engineers and admins approve test cases — never their own')).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Your role and access' })).toBeNull());
    expect(chip).toHaveFocus();
  }, 20000);

  it('explains all three roles and the second-approver rule', async () => {
    open('/');
    fireEvent.click(await screen.findByRole('button', { name: /Signed in as reviewer/ }, { timeout: 8000 }));
    fireEvent.click(await screen.findByRole('button', { name: /How roles work/ }));
    const drawer = await screen.findByRole('dialog', { name: 'How roles work' });
    for (const role of ['QA Compliance Analyst', 'AI Enablement Engineer', 'Administrator']) expect(within(drawer).getByRole('heading', { name: role })).toBeInTheDocument();
    expect(within(drawer).getAllByText('Check pasted text in the sandbox').length).toBeGreaterThan(0);
    expect(within(drawer).queryByText('use_sandbox')).toBeNull();
    expect(within(drawer).getByText('Decisions need a different approver')).toBeInTheDocument();
    expect(within(drawer).getByText('you')).toBeInTheDocument();
  }, 20000);

  it('keeps "New run" visible for an analyst, refused with the reason', async () => {
    open('/runs');
    await waitFor(() => expect(screen.getByRole('button', { name: /New run/ })).toHaveAttribute('aria-disabled', 'true'), { timeout: 8000 });
    const btn = screen.getByRole('button', { name: /New run/ });
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('Engineers and admins can start runs');
    expect(btn).toHaveAccessibleDescription('Engineers and admins can start runs');
    fireEvent.click(btn);
    expect(screen.queryByRole('dialog', { name: /New run/ })).toBeNull();
  }, 20000);

  it('gives an engineer the real "New run" button', async () => {
    open('/runs', 'engineer');
    await screen.findByRole('button', { name: /New run/ }, { timeout: 8000 });
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /New run/ });
      expect(btn).not.toHaveAttribute('aria-disabled');
      expect(btn).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: /New run/ }));
    expect(await screen.findByRole('dialog', { name: /New run/ })).toBeInTheDocument();
  }, 20000);
});

describe('test cases', () => {
  it('shows the loop and both seeded examples, with who can approve the pending one', async () => {
    open('/test-cases');
    expect(await screen.findByRole('list', { name: 'How an override becomes a test case' }, { timeout: 8000 })).toBeInTheDocument();
    expect(await screen.findAllByText('seeded example', {}, { timeout: 8000 })).toHaveLength(2);
    expect(screen.getByText('awaiting an engineer or admin other than demo-seed:qa-reviewer')).toBeInTheDocument();
    const approve = screen.getByRole('button', { name: /Approve/ });
    expect(approve).toHaveAttribute('aria-disabled', 'true');
    expect(approve).toHaveAccessibleDescription(/Engineers and admins approve test cases/);
  }, 20000);
});

describe('change triggers guide', () => {
  it('shows four live steps and remembers when it is hidden', async () => {
    const view = open('/');
    const guide = await screen.findByRole('region', { name: 'Where we are' }, { timeout: 8000 });
    expect(within(guide).getByText(/Prototype · synthetic calls · real public pages · recorded real-model runs/)).toBeInTheDocument();
    expect(await within(guide).findByText(/stale encodings/, {}, { timeout: 8000 })).toBeInTheDocument();
    expect(await within(guide).findByText(/audit chain/, {}, { timeout: 8000 })).toBeInTheDocument();
    expect(within(guide).getByRole('link', { name: /Try it with your own text/ })).toHaveAttribute('href', '/try');
    fireEvent.click(within(guide).getByRole('button', { name: /Hide the where-we-are guide/ }));
    expect(screen.queryByRole('region', { name: 'Where we are' })).toBeNull();
    expect(window.localStorage.getItem(GUIDE_KEY)).toBe('1');
    view.unmount();
    open('/');
    expect(await screen.findByRole('button', { name: /Show where we are/ }, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Where we are' })).toBeNull();
  }, 20000);

  it('animates the route content, and pulses only the healthy dot', async () => {
    open('/');
    await screen.findByRole('region', { name: 'Where we are' }, { timeout: 8000 });
    expect(document.querySelector('main .route-enter')).not.toBeNull();
    await waitFor(() => expect(screen.getByTestId('health-dot').className).toContain('pulse-dot'));
  }, 20000);
});
