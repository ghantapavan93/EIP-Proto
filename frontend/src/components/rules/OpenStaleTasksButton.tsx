import { ListPlus } from 'lucide-react';
import { useOpenStaleTasks } from '../../api/hooks';
import { GatedButton } from '../access/GatedButton';
import { useToast } from '../ui/useToast';

/**
 * Open review tasks for the stale artifacts on `asOf` that have none yet
 * (POST /rules/{code}/impact/evaluate). Reading a rule's impact never opens
 * tasks, so this is the one place they are created from the rule page.
 * Hidden when every stale artifact already has a task.
 */
export function OpenStaleTasksButton({ code, asOf, missing }: { code: string; asOf: string; missing: number }) {
  const evaluate = useOpenStaleTasks(code);
  const { toast } = useToast();
  if (missing === 0) return null;
  return (
    <GatedButton
      action="open_stale_tasks"
      className="btn btn-outline btn-sm normal-case tracking-normal"
      disabled={evaluate.isPending}
      onClick={() =>
        evaluate.mutate(
          { asOf },
          {
            onSuccess: (out) => {
              const opened = missing - out.stale.filter((item) => !item.task_id).length;
              toast({
                title:
                  opened > 0 ? `Opened ${opened} review ${opened === 1 ? 'task' : 'tasks'}` : 'No new review tasks',
                detail: `${code} as of ${asOf}`,
                tone: 'green',
              });
            },
            onError: (err) => toast({ title: 'Review tasks not opened', detail: err.message, tone: 'red' }),
          },
        )
      }
    >
      <ListPlus size={12} aria-hidden /> {evaluate.isPending ? 'Opening…' : `Open review tasks (${missing})`}
    </GatedButton>
  );
}
