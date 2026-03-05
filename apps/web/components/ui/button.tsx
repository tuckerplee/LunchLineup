import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-all duration-200 disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 ring-offset-[var(--bg)]',
    {
        variants: {
            variant: {
                default: 'bg-[var(--brand)] text-white shadow-[var(--shadow-brand)] hover:-translate-y-0.5 hover:shadow-[0_8px_32px_rgba(92,124,250,0.5)]',
                secondary: 'bg-[var(--bg-glass)] text-[var(--text-primary)] border border-[var(--border-bright)] hover:bg-[var(--bg-glass-hover)] hover:-translate-y-0.5',
                ghost: 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-glass)] hover:text-[var(--text-primary)]',
                destructive: 'bg-[var(--rose)] text-white hover:opacity-90',
                outline: 'border border-[var(--border)] bg-transparent text-[var(--text-secondary)] hover:border-[var(--brand)] hover:text-[var(--text-primary)]',
                success: 'bg-[var(--emerald)] text-white shadow-[0_4px_16px_rgba(16,185,129,0.3)] hover:opacity-90',
            },
            size: {
                default: 'h-9 px-4 py-2',
                sm: 'h-8 px-3 text-xs',
                lg: 'h-11 px-6 text-base',
                icon: 'h-9 w-9',
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
