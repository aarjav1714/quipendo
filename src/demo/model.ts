/**
 * The data model of a (made-up) Quip account, shared by the demo account in this folder and by the mock server the tests use.
 * Shapes follow Quip's public Automation API specification. Nothing here comes from a real account.
 */
export const SITE = 'https://acme.quip.com';

export const ME = { id: 'uME00000001', name: 'Jane Doe' };
export const ANN = { id: 'uANN0000001', name: 'Ann Lee' };
/** Only ever mentioned in a comment, never an author, in the test account. */
export const BOB = { id: 'uBOB0000001', name: 'Bob Stone' };

// The folders every account has.
export const F_PRIV = 'fPRIVATE001';
export const F_DESK = 'fDESKTOP001';
export const F_SHARED = 'fSHARED0001';
export const F_ARCH = 'fARCHIVE001';
export const F_STAR = 'fSTARRED001';
export const F_TRASH = 'fTRASH00001';

export interface FixtureMessage {
  id: string;
  author_id: string;
  author_name: string;
  created_usec: number;
  text: string;
  mention_user_ids?: string[];
  annotation?: { id: string; highlighted_section_ids?: string[] };
  files?: Array<{ hash: string; name: string }>;
}

export interface FixtureThread {
  id: string;
  title: string;
  type: 'DOCUMENT' | 'SPREADSHEET' | 'SLIDES' | 'CHAT';
  secret?: string;
  authorId: string;
  created: number;
  updated: number;
  pages: string[];
  messages?: FixtureMessage[];
  /** Document edit records, returned for `message_type=edit`. */
  edits?: Array<{ id: string; created_usec: number } & Record<string, unknown>>;
  movedTo?: string;
  /** The files Quip would send for this thread's exports. Without them the mock sends small placeholders. */
  exports?: { xlsx?: Uint8Array; docx?: Uint8Array; pdf?: Uint8Array };
}

export interface FixtureFolder {
  id: string;
  title: string;
  children: Array<{ folder_id: string } | { thread_id: string }>;
}

export type FixtureBlob = { type: string; bytes: Uint8Array } | { forbidden: true };

export interface Fixture {
  folders: Record<string, FixtureFolder>;
  threads: Record<string, FixtureThread>;
  blobs: Record<string, FixtureBlob>;
  /** Threads the user owns, returned by /1/users/current/threads. */
  owned: string[];
  restrictedFolders: string[];
  /** More people the user directory can name, besides ME, ANN and BOB. */
  users?: Array<{ id: string; name: string }>;
}
