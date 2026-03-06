import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-all duration-200 disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-[#7b9cff] focus-visible:ring-offset-2 ring-offset-[#f4f7fd] active:scale-[0.98]',
    {
        variants: {
            variant: {
                default: 'bg-gradient-to-br from-[#4171ff] via-[#2f63ff] to-[#22b8cf] text-white shadow-[0_10px_28px_rgba(47,99,255,0.3)] hover:-translate-y-0.5 hover:shadow-[0_14px_32px_rgba(47,99,255,0.36)]',
                secondary: 'bg-white text-[var(--text-primary)] border border-[var(--border)] shadow-[var(--shadow-sm)] hover:border-[var(--border-strong)] hover:bg-[#fbfcff] hover:-translate-y-0.5',
                ghost: 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]',
                destructive: 'bg-[var(--rose)] text-white shadow-[0_10px_24px_rgba(231,72,103,0.28)] hover:opacity-95',
                outline: 'border border-[var(--border)] bg-white text-[var(--text-secondary)] hover:border-[#7b9cff] hover:text-[var(--text-primary)] hover:bg-[#f9fbff]',
                success: 'bg-[var(--emerald)] text-white shadow-[0_10px_24px_rgba(23,178,106,0.28)] hover:opacity-95',
            },
            size: {
                default: 'h-10 px-4 py-2',
                sm: 'h-8 px-3 text-xs rounded-lg',
                lg: 'h-11 px-6 text-base rounded-2xl',
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
