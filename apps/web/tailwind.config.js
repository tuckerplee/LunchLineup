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
                border: 'var(--border)',
                input: 'var(--border)',
                ring: 'var(--brand-600)',
                background: 'var(--bg)',
                foreground: 'var(--text)',
                brand: 'var(--brand-600)',
                primary: {
                    DEFAULT: 'var(--brand-600)',
                    foreground: '#ffffff',
                },
                secondary: {
                    DEFAULT: 'var(--surface)',
                    foreground: 'var(--text-muted)',
                },
                destructive: {
                    DEFAULT: 'var(--danger-600)',
                    foreground: '#ffffff',
                },
                muted: {
                    DEFAULT: 'var(--surface-soft)',
                    foreground: 'var(--text-muted)',
                },
                accent: {
                    DEFAULT: 'var(--accent-050)',
                    foreground: 'var(--accent-600)',
                },
                popover: {
                    DEFAULT: 'var(--surface)',
                    foreground: 'var(--text)',
                },
                card: {
                    DEFAULT: 'var(--surface)',
                    foreground: 'var(--text)',
                },
                sidebar: {
                    DEFAULT: 'var(--surface)',
                    foreground: 'var(--text)',
                    border: 'var(--border)',
                    accent: 'rgba(37, 99, 235, 0.12)',
                    'accent-foreground': 'var(--text)',
                    primary: 'var(--brand-600)',
                    'primary-foreground': '#ffffff',
                    ring: 'var(--brand-600)',
                },
            },
            borderRadius: {
                lg: '1rem',
                md: '0.75rem',
                sm: '0.5rem',
            },
            fontFamily: {
                sans: ['var(--font-sans)'],
                mono: ['IBM Plex Mono', 'SFMono-Regular', 'monospace'],
            },
        },
    },
    plugins: [],
};
