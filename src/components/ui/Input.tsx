import * as React from "react";
import { cn } from "@/lib/utils";
import { Eye, EyeOff } from "lucide-react";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
  showPasswordToggle?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", label, error, helperText, showPasswordToggle, id: idProp, ...props }, ref) => {
    const [showPassword, setShowPassword] = React.useState(false);
    const isPassword = type === "password";
    const inputType = isPassword && showPasswordToggle ? (showPassword ? "text" : "password") : type;
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
        <div className="relative">
          <input
            id={id}
            type={inputType}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className={cn(
              "input disabled:cursor-not-allowed disabled:opacity-50",
              isPassword && showPasswordToggle && "pr-10",
              error && "input-error",
              className
            )}
            ref={ref}
            {...props}
          />
          {isPassword && showPasswordToggle && (
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-foreground transition-colors"
            >
              {showPassword ? <EyeOff className="icon-sm" /> : <Eye className="icon-sm" />}
            </button>
          )}
        </div>
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

Input.displayName = "Input";