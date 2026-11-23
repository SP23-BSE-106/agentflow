import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * KFS ledger table: no card wrapper, 2px top border in text color,
 * uppercase letterspaced muted headers, ruled rows with a hover tint.
 * The wrapper carries the ledger top/bottom rules (.ledger-table).
 */
export const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="relative w-full overflow-auto">
      <table
        ref={ref}
        className={cn("ledger-table caption-bottom", className)}
        {...props}
      />
    </div>
  )
);
Table.displayName = "Table";

export const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <thead ref={ref} className={cn("", className)} {...props} />
  )
);
TableHeader.displayName = "TableHeader";

export const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody
      ref={ref}
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
);
TableBody.displayName = "TableBody";

export const TableFooter = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tfoot
      ref={ref}
      className={cn("border-t border-border-strong bg-surface-2 font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  )
);
TableFooter.displayName = "TableFooter";

export const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        "ruled-row data-[state=selected]:bg-[var(--row-hover)]",
        className
      )}
      {...props}
    />
  )
);
TableRow.displayName = "TableRow";

export const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        "h-10 px-3 text-left align-middle text-xs font-semibold text-muted tracking-wider uppercase [&:has([role=checkbox])]:pr-2",
        className
      )}
      {...props}
    />
  )
);
TableHead.displayName = "TableHead";

export const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td
      ref={ref}
      className={cn("px-3 py-3 align-middle [&:has([role=checkbox])]:pr-2 text-foreground/90", className)}
      {...props}
    />
  )
);
TableCell.displayName = "TableCell";

/**
 * Empty table body: one ruled row that says plainly that there is
 * nothing here yet, instead of a bare table with only headers.
 */
export const TableEmptyState: React.FC<{
  colSpan: number;
  title: string;
  body?: string;
}> = ({ colSpan, title, body }) => (
  <tr>
    <td colSpan={colSpan}>
      <div className="empty-state" role="status">
        <p className="empty-state-title">{title}</p>
        {body && <p className="empty-state-body">{body}</p>}
      </div>
    </td>
  </tr>
);
