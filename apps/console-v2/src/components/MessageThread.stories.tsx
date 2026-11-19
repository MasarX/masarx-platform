// MessageThread.stories.tsx — sample conversation with a working composer.
// Future module agents (Customers · messages tab, Shipments · drawer chat,
// Disputes · resolution thread) consume this directly.
import { useState } from 'react';
import { MessageThread, type ThreadMessage } from './MessageThread';

const SEED: ThreadMessage[] = [
  {
    id: 'm1',
    at: '2026-04-26T09:00:00Z',
    author: { id: 'op-1', name: 'Sara Al-Otaibi', role: 'operator' },
    body: 'Your shipment SHP-92011 is at the hub and will be dispatched within the hour.',
  },
  {
    id: 'm2',
    at: '2026-04-26T09:02:00Z',
    author: { id: 'cu-1', name: 'Ahmed B.', role: 'customer' },
    body: 'Got it — please make sure the driver calls 15 min before arrival.',
    attachments: [{ id: 'a1', name: 'gate-photo.jpg' }],
  },
  {
    id: 'm3',
    at: '2026-04-26T09:03:00Z',
    author: { id: 'sys', name: 'System', role: 'system' },
    body: 'Driver D-014 assigned',
  },
];

export function MessageThreadDemo() {
  const [messages, setMessages] = useState<ThreadMessage[]>(SEED);

  return (
    <div style={{ height: 480, maxWidth: 540, padding: 16 }}>
      <div style={{ height: '100%', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
        <MessageThread
          messages={messages}
          composer={{
            placeholder: 'Reply to customer…',
            onSubmit: async (body) => {
              setMessages((prev) => [
                ...prev,
                {
                  id: `m-${prev.length + 1}`,
                  at: new Date().toISOString(),
                  author: { id: 'op-1', name: 'Sara Al-Otaibi', role: 'operator' },
                  body,
                },
              ]);
            },
          }}
        />
      </div>
    </div>
  );
}

export default MessageThreadDemo;
