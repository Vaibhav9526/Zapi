import { useState } from 'react';
import type { AgentProfile } from '../../../shared/types';

interface RoutineModalProps {
  agents: AgentProfile[];
  onClose: () => void;
}

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/**
 * Create-a-routine dialog: name, owning agent, schedule (interval minutes
 * or a daily HH:MM), the task text, and an enabled switch. Upserts via
 * ROUTINE_UPSERT — no id, so main creates a fresh profile.
 */
export function RoutineModal({ agents, onClose }: RoutineModalProps) {
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState(agents[0]?.id ?? 'main');
  const [kind, setKind] = useState<'interval' | 'daily'>('interval');
  const [minutes, setMinutes] = useState('30');
  const [time, setTime] = useState('09:00');
  const [task, setTask] = useState('');
  const [enabled, setEnabled] = useState(true);

  const mins = parseInt(minutes, 10);
  const scheduleOk = kind === 'interval' ? Number.isFinite(mins) && mins >= 1 : TIME_RE.test(time.trim());
  const canSave = name.trim().length > 0 && task.trim().length > 0 && scheduleOk;

  const save = () => {
    if (!canSave) return;
    window.flicky.upsertRoutine({
      agentId,
      name: name.trim(),
      kind,
      intervalMinutes: kind === 'interval' ? mins : undefined,
      timeOfDay: kind === 'daily' ? time.trim() : undefined,
      task: task.trim(),
      enabled,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>New routine</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-field">
          <div className="modal-label">Name</div>
          <input
            autoFocus
            className="modal-input"
            placeholder="e.g. morning standup summary"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="modal-field">
          <div className="modal-label">Agent</div>
          <div className="kao-presets">
            {agents.map((a) => (
              <button
                key={a.id}
                className={`agent-filter-chip ${agentId === a.id ? 'on' : ''}`}
                onClick={() => setAgentId(a.id)}
              >
                <span className="kao" style={{ color: a.color }}>{a.kaomoji}</span>
                {a.name}
              </button>
            ))}
          </div>
        </div>

        <div className="modal-field">
          <div className="modal-label">Schedule</div>
          <div className="seg">
            <button className={kind === 'interval' ? 'on' : ''} onClick={() => setKind('interval')}>
              Every N minutes
            </button>
            <button className={kind === 'daily' ? 'on' : ''} onClick={() => setKind('daily')}>
              Daily at a time
            </button>
          </div>
          {kind === 'interval' ? (
            <input
              className="modal-input"
              type="number"
              min={1}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              placeholder="30"
            />
          ) : (
            <input
              className="modal-input"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          )}
        </div>

        <div className="modal-field">
          <div className="modal-label">Task</div>
          <textarea
            className="modal-input modal-textarea"
            rows={3}
            placeholder="what the agent should do — e.g. check my open PRs and summarize reviews"
            value={task}
            onChange={(e) => setTask(e.target.value)}
          />
        </div>

        <div className="modal-field">
          <label className="modal-check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>Enabled — starts running on schedule right away</span>
          </label>
        </div>

        <div className="modal-footer">
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="btn xs subtle" onClick={onClose}>Cancel</button>
            <button className="btn xs primary" onClick={save} disabled={!canSave}>
              Create routine
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
