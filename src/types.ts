export interface Link { url: string; label: string }
export interface Person { name: string; url: string | null }
export interface DiscussionComment {
  id: number;
  author: string | null;
  text: string;
  time: string | null;
  links: Link[];
  attachments: Link[];
}
export interface DiscussionEvent { id: number; text: string; time: string | null }
export interface Discussion { comments: DiscussionComment[]; events: DiscussionEvent[] }
export type TaskStatus = 'todo' | 'doing' | 'review' | 'done' | 'unknown';
export interface Task {
  id: number;
  url: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  checklist: { text: string; done: boolean }[];
  status: TaskStatus;
  statusLabel: string;
  result: string | null;
  dueDate: string | null;
  dueLabel: string | null;
  project: Link | null;
  creator: Person | null;
  assignee: Person | null;
  watchers: Person[];
  links: Link[];
  attachments: Link[];
  discussion: Discussion;
  canSubmit: boolean;
  readSideEffects: string[];
}
