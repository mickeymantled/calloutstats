interface Props {
  handle: string;
  avatarUrl: string | null | undefined;
  size?: "sm" | "lg";
}

/** Avatar image with an initial-letter fallback. Plain <img>: no optimizer in a static export. */
export function Avatar({ handle, avatarUrl, size = "sm" }: Props) {
  const cls = `avatar${size === "lg" ? " lg" : ""}`;
  if (avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={cls} src={avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />;
  }
  const initial = (handle.replace(/^[^a-z0-9]+/i, "")[0] || handle[0] || "?").toUpperCase();
  return <span className={cls} aria-hidden="true">{initial}</span>;
}
