/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: 'class',
    content: [
        './app/**/*.{ts,tsx}',
        './components/**/*.{ts,tsx}',
        './pages/**/*.{ts,tsx}',
    ],
    theme: {
        extend: {
            colors: {
                border: 'hsl(var(--twc-border))',
                input: 'hsl(var(--twc-border))',
                ring: 'hsl(var(--twc-brand))',
                background: 'hsl(var(--twc-bg))',
                foreground: 'hsl(var(--twc-text))',
                primary: {
                    DEFAULT: 'hsl(var(--twc-brand))',
                    foreground: '0 0% 100%',
                },
                secondary: {
                    DEFAULT: 'hsl(var(--twc-elevated))',
                    foreground: 'hsl(var(--twc-text-secondary))',
                },
                destructive: {
                    DEFAULT: '0 84.2% 60.2%',
                    foreground: '0 0% 100%',
                },
                muted: {
                    DEFAULT: 'hsl(var(--twc-elevated))',
                    foreground: 'hsl(var(--twc-text-muted))',
                },
                accent: {
                    DEFAULT: 'hsl(var(--twc-glass))',
                    foreground: 'hsl(var(--twc-text))',
                },
                popover: {
                    DEFAULT: 'hsl(var(--twc-elevated))',
                    foreground: 'hsl(var(--twc-text))',
                },
                card: {
                    DEFAULT: 'hsl(var(--twc-elevated))',
                    foreground: 'hsl(var(--twc-text))',
                },
                sidebar: {
                    DEFAULT: 'hsl(var(--twc-elevated))',
                    foreground: 'hsl(var(--twc-text))',
                    border: 'hsl(var(--twc-border))',
                    accent: 'rgba(92,124,250,0.12)',
                    'accent-foreground': 'hsl(var(--twc-text))',
                    primary: 'hsl(var(--twc-brand))',
                    'primary-foreground': '0 0% 100%',
                    ring: 'hsl(var(--twc-brand))',
                },
            },
            borderRadius: {
                lg: '0.75rem',
                md: '0.5rem',
                sm: '0.375rem',
            },
            fontFamily: {
                sans: ['Inter', 'system-ui', 'sans-serif'],
                mono: ['JetBrains Mono', 'monospace'],
            },
        },
    },
    plugins: [],
};
