export default function LoadingSpinner({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const sizeClass = {
    sm: "loading-sm",
    md: "loading-md",
    lg: "loading-lg",
  }[size];

  return <span className={`loading loading-spinner ${sizeClass}`} />;
}
