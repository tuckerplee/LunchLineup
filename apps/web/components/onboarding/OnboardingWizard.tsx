'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

export function OnboardingWizard() {
    const router = useRouter();
    const [step, setStep] = useState(1);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [formData, setFormData] = useState({
        tenantName: '',
        firstLocationName: '',
    });

    const nextStep = () => {
        setError(null);
        if (step === 1 && !formData.tenantName.trim()) {
            setError('Organization name is required.');
            return;
        }
        if (step === 2 && !formData.firstLocationName.trim()) {
            setError('Location name is required.');
            return;
        }
        setStep(s => s + 1);
    };

    const handleComplete = async () => {
        try {
            setIsSubmitting(true);
            setError(null);

            // In a real app, POST to /api/onboarding or /api/tenants
            const res = await fetch('/api/v1/locations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: formData.firstLocationName,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
                }),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.message || 'Failed to provision workspace');
            }

            // Redirect to dashboard explicitly 
            router.push('/dashboard');
            router.refresh();
        } catch (err) {
            setError((err as Error).message);
            setIsSubmitting(false);
            setStep(2); // Go back to allow correction
        }
    };

    return (
        <div className="max-w-md mx-auto p-6 bg-white rounded-lg shadow-md border border-gray-100">
            <h2 className="text-2xl font-bold mb-2 text-gray-900">Welcome to LunchLineup</h2>
            <p className="mb-6 text-sm text-gray-500 font-medium">Step {step} of 3</p>

            {error && (
                <div className="mb-4 p-3 bg-red-50 text-red-700 rounded text-sm border border-red-200">
                    {error}
                </div>
            )}

            {step === 1 && (
                <div className="animate-in fade-in slide-in-from-right-4 duration-300">
                    <label className="block mb-2 font-medium text-gray-700 text-sm">Organization Name</label>
                    <input
                        className="w-full p-2.5 border border-gray-300 focus:border-primary focus:ring-1 focus:ring-primary rounded-md mb-4 outline-none transition-all"
                        value={formData.tenantName}
                        onChange={e => setFormData({ ...formData, tenantName: e.target.value })}
                        placeholder="e.g. Acme Dining Corp"
                        autoFocus
                        onKeyDown={(e) => e.key === 'Enter' && nextStep()}
                    />
                    <button onClick={nextStep} className="w-full py-2.5 bg-primary hover:bg-primary/90 text-white rounded-md font-medium transition-colors">Continue</button>
                </div>
            )}

            {step === 2 && (
                <div className="animate-in fade-in slide-in-from-right-4 duration-300">
                    <label className="block mb-2 font-medium text-gray-700 text-sm">First Location Name</label>
                    <input
                        className="w-full p-2.5 border border-gray-300 focus:border-primary focus:ring-1 focus:ring-primary rounded-md mb-4 outline-none transition-all"
                        value={formData.firstLocationName}
                        onChange={e => setFormData({ ...formData, firstLocationName: e.target.value })}
                        placeholder="e.g. Downtown Cafe"
                        autoFocus
                        onKeyDown={(e) => e.key === 'Enter' && nextStep()}
                    />
                    <div className="flex gap-3">
                        <button onClick={() => setStep(1)} className="px-4 py-2.5 border border-gray-300 text-gray-700 rounded-md font-medium hover:bg-gray-50 transition-colors">Back</button>
                        <button onClick={nextStep} className="flex-1 py-2.5 bg-primary hover:bg-primary/90 text-white rounded-md font-medium transition-colors">Continue</button>
                    </div>
                </div>
            )}

            {step === 3 && (
                <div className="text-center animate-in fade-in zoom-in-95 duration-300">
                    <div className="mb-6 flex justify-center">
                        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center">
                            <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                        </div>
                    </div>
                    <p className="mb-2 font-medium text-gray-900">You're all set, {formData.tenantName}!</p>
                    <p className="mb-6 text-sm text-gray-500">We've provisioned the {formData.firstLocationName} location.</p>
                    <button
                        onClick={handleComplete}
                        disabled={isSubmitting}
                        className="w-full py-2.5 bg-green-600 hover:bg-green-700 disabled:opacity-70 disabled:cursor-not-allowed text-white rounded-md font-medium transition-colors flex items-center justify-center gap-2"
                    >
                        {isSubmitting ? (
                            <><Loader2 className="w-4 h-4 animate-spin" /> Provisioning Workspace...</>
                        ) : 'Launch Dashboard'}
                    </button>
                    <button onClick={() => setStep(2)} className="mt-3 text-sm text-gray-500 hover:text-gray-900 transition-colors" disabled={isSubmitting}>
                        Wait, I need to change something
                    </button>
                </div>
            )}
        </div>
    );
}
