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
                    accent: 'rgba(47,99,255,0.12)',
                    'accent-foreground': 'hsl(var(--twc-text))',
                    primary: 'hsl(var(--twc-brand))',
                    'primary-foreground': '0 0% 100%',
                    ring: 'hsl(var(--twc-brand))',
                },
            },
            borderRadius: {
                lg: '1rem',
                md: '0.75rem',
                sm: '0.5rem',
            },
            fontFamily: {
                sans: ['Plus Jakarta Sans', 'Avenir Next', 'Segoe UI', 'sans-serif'],
                mono: ['IBM Plex Mono', 'SFMono-Regular', 'monospace'],
            },
        },
    },
    plugins: [],
};
