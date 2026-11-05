import type { Metadata } from "next";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <main className="container" style={{ padding: "48px 12px" }}>
      <h1>Not found</h1>
      <p className="muted">That page or KOL is not in the current dataset.</p>
      <p><a href="/">← All KOLs</a></p>
    </main>
  );
}
