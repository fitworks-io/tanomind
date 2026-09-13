type ProjectAvatarProps = {
  project: string;
  imageUrl?: string;
  label?: string;
  variant?: "feed" | "compact";
};

export function ProjectAvatar({ project, imageUrl, label, variant = "feed" }: ProjectAvatarProps) {
  const className = variant === "compact" ? "right-account-avatar" : "feed-profile-image";
  return <span className={className} aria-hidden="true">
    <img src={imageUrl || `https://${project}/favicon.ico`} alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} />
    <b>{(label || project).charAt(0).toUpperCase()}</b>
  </span>;
}
