import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './api/queryClient';
import { ToastProvider } from './components/ui/Toast';
import { AppShell } from './components/layout/AppShell';
import { LoginPage } from './pages/Login';
import { HomePage } from './pages/Home';
import { RulesPage } from './pages/Rules';
import { RuleDetailPage } from './pages/RuleDetail';
import { ArtifactsPage } from './pages/Artifacts';
import { ArtifactDetailPage } from './pages/ArtifactDetail';
import { RunsPage } from './pages/Runs';
import { RunDetailPage } from './pages/RunDetail';
import { RunTranscriptPage } from './pages/RunTranscript';
import { RunComparePage } from './pages/RunCompare';
import { ReviewPage } from './pages/Review';
import { TestCasesPage } from './pages/TestCases';
import { AuditPage } from './pages/Audit';
import { ContractsPage } from './pages/Contracts';
import { ContractDetailPage } from './pages/ContractDetail';
import { ReadinessPage } from './pages/Readiness';
import { EvalsPage } from './pages/Evals';
import { ModelsPage } from './pages/Models';
import { TryPage } from './pages/Try';
import { EmptyState } from './components/ui/EmptyState';

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
