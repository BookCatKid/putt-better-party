// The hash-pinned bundles are verified by prepare-client.py. These declarations
// describe only the exports recovered from the original code, not its entire API.
declare module '*specValidation-vqop-JBL.js' {
  export function a(specification: unknown): void;
  export function r(specification: unknown): unknown;
}
declare module '*date-D4dx3Sc1.js' {
  export function a(date: Date): number;
}
declare module '*createServerFn-BfnFvdmx.js' {
  export function n(
    identifier: string,
  ): (options: {
    data: unknown;
    method: 'GET' | 'POST';
    fetch: (relative: string, options: RequestInit) => Promise<Response>;
  }) => Promise<unknown>;
}
