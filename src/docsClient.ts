import axios from "axios";

const DOCS_API = "https://docs.googleapis.com/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

let cachedToken: { access_token: string; expires_at: number } | null = null;

export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expires_at > now + 60_000) {
    return cachedToken.access_token;
  }

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN env vars");
  }

  const resp = await axios.post(TOKEN_URL, {
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });

  cachedToken = {
    access_token: resp.data.access_token,
    expires_at: now + resp.data.expires_in * 1000,
  };

  return cachedToken.access_token;
}

export async function docsGet(docId: string): Promise<DocsDocument> {
  const token = await getAccessToken();
  const resp = await axios.get(`${DOCS_API}/documents/${docId}`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { includeTabsContent: true },
  });
  return resp.data as DocsDocument;
}

export async function docsBatchUpdate(docId: string, requests: unknown[]): Promise<void> {
  const token = await getAccessToken();
  await axios.post(
    `${DOCS_API}/documents/${docId}:batchUpdate`,
    { requests },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

export interface DocsDocument {
  documentId: string;
  title: string;
  tabs?: DocsTab[];
}

export interface DocsTab {
  tabProperties: {
    tabId: string;
    title: string;
    index: number;
  };
  documentTab?: {
    body: {
      content: StructuralElement[];
    };
  };
  childTabs?: DocsTab[];
}

export interface StructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: Paragraph;
  table?: unknown;
  sectionBreak?: unknown;
}

export interface Paragraph {
  elements: ParagraphElement[];
  paragraphStyle?: {
    namedStyleType?: string;
  };
}

export interface ParagraphElement {
  startIndex?: number;
  endIndex?: number;
  textRun?: {
    content: string;
    textStyle?: unknown;
  };
}
