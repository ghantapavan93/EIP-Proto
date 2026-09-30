import { lazy, type ComponentType } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './api/queryClient';
import { ToastProvider } from './components/ui/Toast';
import { AppShell } from './components/layout/AppShell';
import { LoginPage } from './pages/Login';
import { HomePage } from './pages/Home';
import { EmptyState } from './components/ui/EmptyState';

/**
 * A screen loaded on first visit, so the first paint ships only the shell,
 * login and home. Pages use named exports; lazy() needs a default one.
 */
function lazyPage<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}

const RulesPage = lazyPage(() => import('./pages/Rules'), 'RulesPage');
const RuleDetailPage = lazyPage(() => import('./pages/RuleDetail'), 'RuleDetailPage');
const ArtifactsPage = lazyPage(() => import('./pages/Artifacts'), 'ArtifactsPage');
const ArtifactDetailPage = lazyPage(() => import('./pages/ArtifactDetail'), 'ArtifactDetailPage');
const RunsPage = lazyPage(() => import('./pages/Runs'), 'RunsPage');
const RunDetailPage = lazyPage(() => import('./pages/RunDetail'), 'RunDetailPage');
const RunTranscriptPage = lazyPage(() => import('./pages/RunTranscript'), 'RunTranscriptPage');
const RunComparePage = lazyPage(() => import('./pages/RunCompare'), 'RunComparePage');
const ReviewPage = lazyPage(() => import('./pages/Review'), 'ReviewPage');
const TestCasesPage = lazyPage(() => import('./pages/TestCases'), 'TestCasesPage');
const AuditPage = lazyPage(() => import('./pages/Audit'), 'AuditPage');
const GovernancePage = lazyPage(() => import('./pages/Governance'), 'GovernancePage');
const ContractsPage = lazyPage(() => import('./pages/Contracts'), 'ContractsPage');
const ContractDetailPage = lazyPage(() => import('./pages/ContractDetail'), 'ContractDetailPage');
const ReadinessPage = lazyPage(() => import('./pages/Readiness'), 'ReadinessPage');
const EvalsPage = lazyPage(() => import('./pages/Evals'), 'EvalsPage');
const ModelsPage = lazyPage(() => import('./pages/Models'), 'ModelsPage');
const TryPage = lazyPage(() => import('./pages/Try'), 'TryPage');

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<AppShell />}>
              <Route index element={<HomePage />} />
              <Route path="/rules" element={<RulesPage />} />
              <Route path="/rules/:code" element={<RuleDetailPage />} />
              <Route path="/artifacts" element={<ArtifactsPage />} />
              <Route path="/artifacts/:code" element={<ArtifactDetailPage />} />
              <Route path="/contracts" element={<ContractsPage />} />
              <Route path="/contracts/:code" element={<ContractDetailPage />} />
              <Route path="/readiness" element={<ReadinessPage />} />
              <Route path="/evals" element={<EvalsPage />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/runs" element={<RunsPage />} />
              <Route path="/runs/compare" element={<RunComparePage />} />
              <Route path="/runs/:id" element={<RunDetailPage />} />
              <Route path="/runs/:id/transcripts/:code" element={<RunTranscriptPage />} />
              <Route path="/review" element={<ReviewPage />} />
              <Route path="/test-cases" element={<TestCasesPage />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path="/governance" element={<GovernancePage />} />
              <Route path="/try" element={<TryPage />} />
              <Route
                path="*"
                element={
                  <EmptyState
                    title="Not found"
                    hint="No screen at this address."
                    className="py-16"
                    action={
                      <Link to="/" className="btn btn-outline btn-sm hover:no-underline">
                        Back to change triggers
                      </Link>
                    }
                  />
                }
              />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
