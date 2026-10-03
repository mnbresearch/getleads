/**
 * Hand the browser a file to save.
 *
 * A blob: URL on an <a download> is a download, not a page load and not a network request,
 * so the Content-Security-Policy in vercel.json (which has no blob: anywhere) does not stand
 * in its way - checked against the real headers, not assumed.
 *
 * The anchor has to be in the document for the click to count in Firefox, and the blob URL
 * has to outlive the click: revoking it in the same tick cancels the download in Firefox and
 * Safari, and the "download" silently produces nothing.
 */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 30_000);
}

/** Save text as a file. */
export function saveText(text: string, filename: string, type = "text/plain;charset=utf-8") {
  saveBlob(new Blob([text], { type }), filename);
}

/** A name safe to use inside a file name: "Acme & Sons / EU" -> "acme-sons-eu". */
export function fileSlug(name: string, fallback = "workspace"): string {
  const s = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || fallback;
}
