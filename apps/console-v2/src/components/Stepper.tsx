// Stepper.tsx — horizontal lifecycle indicator. Mirrors demo `stepper()`.
// Each stage gets `is-done` (before current), `is-current` (matching id),
// or no extra class (after current). The first node renders a checkmark
// for done steps, otherwise the 1-based index.

export interface StepperStage {
  id: string;
  label: string;
  meta?: string;
}

export interface StepperProps {
  stages: StepperStage[];
  current: string;
  className?: string;
}

export function Stepper({ stages, current, className }: StepperProps) {
  const idx = stages.findIndex((s) => s.id === current);
  const classes = ['lifecycle', className].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      {stages.map((s, i) => {
        const stepClass = ['lifecycle__step'];
        if (i < idx) stepClass.push('is-done');
        else if (i === idx) stepClass.push('is-current');
        return (
          <div key={s.id} className={stepClass.join(' ')}>
            <span className="lifecycle__node">{i < idx ? '✓' : String(i + 1)}</span>
            <span>{s.label}</span>
            {s.meta ? <span className="lifecycle__meta">{s.meta}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
