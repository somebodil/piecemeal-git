export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface HttpResponse {
  status: number;
  /** Names in lower case */
  headers: Record<string, string>;
  body: Uint8Array;
}

/** One request, answered whole. Obsidian on a phone can do no more than that. */
export type Http = (request: HttpRequest) => Promise<HttpResponse>;
