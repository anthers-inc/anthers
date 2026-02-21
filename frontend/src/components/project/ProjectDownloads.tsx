import type { Asset } from "../../lib/api";
import { ArrowDownTrayIcon } from "@heroicons/react/24/outline";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const PLATFORM_LABELS: Record<string, string> = {
  windows: "Windows",
  mac: "macOS",
  linux: "Linux",
  web: "Web",
  android: "Android",
  ios: "iOS",
};

export default function ProjectDownloads({
  assets,
  mediaType,
}: {
  assets: Asset[];
  mediaType: string;
}) {
  if (assets.length === 0) return null;

  // Group by platform for games
  const grouped =
    mediaType === "game"
      ? assets.reduce<Record<string, Asset[]>>((acc, asset) => {
          const key = asset.platform || "other";
          if (!acc[key]) acc[key] = [];
          acc[key].push(asset);
          return acc;
        }, {})
      : { downloads: assets };

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Downloads</h2>
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              {mediaType === "game" && <th>Platform</th>}
              <th>File</th>
              <th>Size</th>
              {assets.some((a) => a.version) && <th>Version</th>}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(grouped).map(([platform, platformAssets]) =>
              platformAssets.map((asset) => (
                <tr key={asset.id}>
                  {mediaType === "game" && (
                    <td className="font-medium">
                      {PLATFORM_LABELS[platform] ?? platform}
                    </td>
                  )}
                  <td>{asset.filename}</td>
                  <td className="text-base-content/60">
                    {formatSize(asset.file_size)}
                  </td>
                  {assets.some((a) => a.version) && (
                    <td className="text-base-content/60">{asset.version}</td>
                  )}
                  <td>
                    <a
                      href={asset.file}
                      className="btn btn-sm btn-primary"
                      download
                    >
                      <ArrowDownTrayIcon className="w-4 h-4" />
                      Download
                    </a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
