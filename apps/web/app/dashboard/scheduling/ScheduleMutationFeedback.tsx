'use client';

import { RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ScheduleCommandFeedback } from './schedule-command-reducer';

type ScheduleMutationFeedbackProps = {
  feedbackByShiftId: Record<string, ScheduleCommandFeedback>;
  onUndo: (shiftId: string) => void;
  onDismiss: (shiftId: string, commandId: string) => void;
};

export function ScheduleMutationFeedback({
  feedbackByShiftId,
  onUndo,
  onDismiss,
}: ScheduleMutationFeedbackProps) {
  const visible = [...Object.values(feedbackByShiftId)]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 3);
  if (visible.length === 0) return null;

  return (
    <div className="schedule-mutation-feedback" aria-label="Recent schedule changes" aria-live="polite">
      {visible.map((feedback) => (
        <div
          key={`${feedback.shiftId}:${feedback.commandId}`}
          className={`schedule-mutation-feedback__item schedule-mutation-feedback__item--${feedback.phase}`}
          role={feedback.phase === 'failed' ? 'alert' : 'status'}
        >
          <span className="schedule-mutation-feedback__message">{feedback.message}</span>
          <span className="schedule-mutation-feedback__actions">
            {feedback.canUndo && feedback.phase === 'saved' ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onUndo(feedback.shiftId)}
              >
                <RotateCcw aria-hidden="true" size={14} /> Undo
              </Button>
            ) : null}
            {feedback.phase !== 'saving' && feedback.phase !== 'confirming' ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Dismiss schedule change status"
                onClick={() => onDismiss(feedback.shiftId, feedback.commandId)}
              >
                <X aria-hidden="true" size={15} />
              </Button>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}
