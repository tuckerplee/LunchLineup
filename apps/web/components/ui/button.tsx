import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap border font-semibold outline-none disabled:pointer-events-none disabled:opacity-50 transition-[transform,box-shadow,background-color,border-color,color] duration-120 ease-[var(--ease-saas)] focus-visible:shadow-[var(--focus-ring)]',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-[var(--brand-600)] text-white shadow-[var(--e-1)] hover:bg-[var(--brand-700)] hover:-translate-y-px hover:shadow-[var(--e-2)] active:bg-[var(--brand-800)] active:translate-y-0 active:shadow-[var(--e-1)]',
        secondary:
          'border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--e-0)] hover:bg-[#f1f5f9] active:bg-[#e2e8f0]',
        ghost:
          'border-transparent bg-transparent text-[var(--text)] hover:bg-[rgba(79,70,229,0.08)] active:bg-[rgba(79,70,229,0.14)]',
        destructive:
          'border-transparent bg-[var(--danger-600)] text-white shadow-[var(--e-1)] hover:bg-[#b91c1c] active:bg-[#991b1b]',
        outline:
          'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--text)] hover:border-[var(--border-strong)] active:bg-[#edf2f7]',
        success:
          'border-transparent bg-[var(--success-700)] text-white shadow-[var(--e-1)] hover:bg-[#166534] active:bg-[#14532d]',
      },
      size: {
        default: 'h-10 px-4 text-sm rounded-[var(--r-md)]',
        sm: 'h-8 px-3 text-[13px] rounded-[12px]',
        lg: 'h-12 px-[18px] text-base rounded-[var(--r-md)]',
        icon: 'h-10 w-10 rounded-[var(--r-md)]',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  )
);
Button.displayName = 'Button';

export { Button, buttonVariants };
