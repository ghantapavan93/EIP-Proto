import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, Link2, ListChecks } from 'lucide-react';
import { api, MOCK_MODE } from '../api/client';
import { useHealthDeep } from '../api/hooks';
import { isApiError } from '../api/errors';
import { setCredentials } from '../api/auth';
import type { HealthDeepOut, MetaOut } from '../api/types';
import { Field } from '../components/layout/Page';
import { ErrorState } from '../components/ui/ErrorState';
import { Chip } from '../components/ui/Chip';
import { safeNext } from '../lib/redirect';

const PITCH = 'When CMS changes a rule on October 1, which of your scripts, prompts and pages are now wrong?';

const ROLES = [
  { role: 'analyst', can: 'review and decide tasks' },
  { role: 'engineer', can: 'plus runs, scans, versions, republish, approve' },
  { role: 'admin', can: 'everything the engineer can' },
];

/** A count from the unauthenticated /health/deep, or null when the server did not send one. */
function count(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Three proof points. Numbers appear only when /health/deep reported them
 * (never in mock mode, never invented); otherwise the line stands without one.
 */
function proofPoints(health: HealthDeepOut | undefined): Array<{ icon: ReactNode; n: number | null; head: string; tail: string }> {
  return [
    { icon: <BookOpen size={15} />, n: count(health?.rules), head: 'versioned rules', tail: 'Every change is a new version with an effective date; nothing is edited in place.' },
    { icon: <ListChecks size={15} />, n: count(health?.artifacts), head: 'linked artifacts', tail: 'Scripts, prompts, templates and pages, each tied to the clause it encodes.' },
    { icon: <Link2 size={15} />, n: null, head: 'Hash-chained audit', tail: 'Every decision is recorded against a named role, and the chain verifies end to end.' },
  ];
}

function ProofPoint({ icon, n, head, tail }: { icon: ReactNode; n: number | null; head: string; tail: string }) {
  return (
    <li className="flex gap-3">
      {/* teal on navy 4.94:1; the icon is decorative */}
      <span aria-hidden className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-on-navy/10 text-teal">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-on-navy">
          {n !== null ? (
            <>
              <span className="font-mono tabular-nums">{n}</span> {head}
            </>
          ) : (
            head.charAt(0).toUpperCase() + head.slice(1)
          )}
        </span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-on-navy-muted">{tail}</span>
      </span>
    </li>
  );
}

/** The password == username accounts; only shown while the server still runs them. */
const DEMO = ROLES.map((r) => ({ ...r, username: r.role, password: r.role }));

export function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const health = useHealthDeep(!MOCK_MODE);
  // Advertise the demo passwords only when they actually work (localhost default
  // setup, or mock mode). A published instance has per-person accounts.
  const showDemo = MOCK_MODE || health.data?.default_credentials === true;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const creds = { username: username.trim(), password };
    try {
      // Probe /meta with the typed credentials; only store them if the server accepts.
      await api.get<MetaOut>('/meta', {
        credentials: creds,
        noAuthRedirect: true,
      });
      setCredentials(creds);
      qc.clear();
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (err) {
      setError(isApiError(err) && err.status === 401 ? new Error('Invalid username or password.') : err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-canvas">
      <div className="hidden w-[420px] shrink-0 flex-col justify-between bg-navy px-10 py-9 text-on-navy lg:flex">
        <div>
          <div className="text-[15px] font-bold uppercase tracking-[0.14em]">Backstop</div>
          <div className="mt-1 text-[12px] text-on-navy-faint">Prototype for EIP</div>
          <p className="mt-12 text-[22px] font-semibold leading-snug tracking-[-0.01em] text-on-navy">{PITCH}</p>
          <p className="mt-4 text-[13px] leading-relaxed text-on-navy-muted">
            A rule changes, a prompt changes, or a vendor swaps the model. Backstop answers what still holds, what
            broke, where the evidence is, and who owns the decision.
          </p>
          <ul className="mt-9 space-y-5 border-t border-on-navy/15 pt-7" aria-label="What Backstop keeps">
            {proofPoints(health.data).map((p) => (
              <ProofPoint key={p.head} {...p} />
            ))}
          </ul>
        </div>
        <div className="text-[11px] text-on-navy-muted">Prototype · not affiliated with Elite Insurance Partners</div>
      </div>

      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-[420px]">
          {/* Below lg the navy panel is hidden: the phone view still has to say what this is. */}
          <div className="mb-4 lg:hidden">
            <div className="text-[15px] font-bold uppercase tracking-[0.14em] text-navy">Backstop</div>
            <div className="text-[12px] text-ink-2">Prototype for EIP</div>
            <p className="mt-2 text-[13px] font-semibold leading-snug text-ink">{PITCH}</p>
          </div>
          <div className="card card-hero p-6">
            <h1 className="text-[20px] tracking-[-0.01em]">Sign in to Backstop</h1>
            <p className="mt-1 text-xs text-ink-2">
              {showDemo ? 'Demo accounts' : 'Accounts are issued per person'} · HTTP Basic, a stand-in for SSO.
              Credentials stay in this tab&apos;s session storage.
              {MOCK_MODE && (
                <>
                  {' '}
                  <Chip tone="amber" className="ml-1">
                    mock mode
                  </Chip>
                </>
              )}
            </p>

            <form onSubmit={submit} className="mt-5 space-y-3">
              <Field label="Username" htmlFor="username">
                <input
                  id="username"
                  className="input"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  autoFocus
                />
              </Field>
              <Field label="Password" htmlFor="password">
                <input
                  id="password"
                  type="password"
                  className="input"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Field>
              {error ? <ErrorState error={error} title="Sign-in failed" /> : null}
              <button type="submit" className="btn w-full justify-center" disabled={busy}>
                {busy ? 'Checking…' : 'Sign in'}
              </button>
            </form>

            {showDemo ? (
              <div className="mt-6 border-t border-hairline pt-4">
                <div className="eyebrow mb-2">Demo credentials</div>
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-[1px] text-ink-3">
                      <th className="py-1 font-semibold">user / password</th>
                      <th className="py-1 font-semibold">role</th>
                      <th className="py-1 font-semibold">can</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DEMO.map((d) => (
                      <tr key={d.username} className="border-t border-hairline">
                        <td className="py-1.5 pr-3 font-mono">
                          <button
                            type="button"
                            className="whitespace-nowrap text-left text-teal-ink hover:underline"
                            onClick={() => {
                              setUsername(d.username);
                              setPassword(d.password);
                            }}
                          >
                            {d.username} / {d.password}
                          </button>
                        </td>
                        <td className="py-1.5">
                          <Chip tone="slate">{d.role}</Chip>
                        </td>
                        <td className="py-1.5 text-ink-2">{d.can}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mt-6 border-t border-hairline pt-4">
                <div className="eyebrow mb-2">Roles</div>
                <p className="mb-2 text-[12px] text-ink-2">
                  Every action is recorded against the user and role that took it.
                </p>
                <table className="w-full text-[12px]">
                  <tbody>
                    {ROLES.map((r) => (
                      <tr key={r.role} className="border-t border-hairline">
                        <td className="py-1.5">
                          <Chip tone="slate">{r.role}</Chip>
                        </td>
                        <td className="py-1.5 text-ink-2">{r.can}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <p className="mt-3 text-center text-[11px] text-ink-3 lg:hidden">
            Prototype · synthetic data · not affiliated with Elite Insurance Partners
          </p>
        </div>
      </div>
    </div>
  );
}
