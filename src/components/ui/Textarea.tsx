import * as React from "react";
import { cn } from "@/lib/utils";

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, error, helperText, id: idProp, ...props }, ref) => {
    // The label is wired to the field by id, so a screen reader (and a
    // click on the label) always lands on the right control.
    const generatedId = React.useId();
    const id = idProp ?? generatedId;
    const describedBy = error ? `${id}-error` : helperText ? `${id}-helper` : undefined;

    return (
      <div className="w-full space-y-1.5">
        {label && (
          <label htmlFor={id} className="text-xs font-semibold text-muted tracking-wide uppercase">
            {label}
          </label>
        )}
        <textarea
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            "textarea disabled:cursor-not-allowed disabled:opacity-50",
            error && "textarea-error",
            className
          )}
          ref={ref}
          {...props}
        />
        {error && (
          <p id={`${id}-error`} className="text-xs text-danger font-medium">{error}</p>
        )}
        {!error && helperText && (
          <p id={`${id}-helper`} className="text-xs text-muted/80">{helperText}</p>
        )}
      </div>
    );
  }
);

Textarea.displayName = "Textarea";
