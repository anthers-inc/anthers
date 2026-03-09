interface PaginationProps {
  count: number;
  next: string | null;
  previous: string | null;
  currentPage: number;
  onPageChange: (page: number) => void;
  pageSize?: number;
}

export default function Pagination({
  count,
  next,
  previous,
  currentPage,
  onPageChange,
  pageSize = 20,
}: PaginationProps) {
  const totalPages = Math.ceil(count / pageSize);

  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-center gap-4 mt-8">
      <button
        className="btn btn-sm btn-outline"
        disabled={!previous}
        onClick={() => onPageChange(currentPage - 1)}
      >
        Previous
      </button>
      <span className="text-sm text-base-content/70">
        Page {currentPage} of {totalPages}
      </span>
      <button
        className="btn btn-sm btn-outline"
        disabled={!next}
        onClick={() => onPageChange(currentPage + 1)}
      >
        Next
      </button>
    </div>
  );
}
