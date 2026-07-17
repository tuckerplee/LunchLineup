'use client';

import { useMemo, type CSSProperties } from 'react';
import { getIanaTimeZoneOptions } from './location-form';

type LocationTimeZoneInputProps = {
    id: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    className?: string;
    style?: CSSProperties;
};

export function LocationTimeZoneInput({
    id,
    value,
    onChange,
    disabled = false,
    className = 'form-input',
    style,
}: LocationTimeZoneInputProps) {
    const options = useMemo(() => getIanaTimeZoneOptions([value]), [value]);
    const listId = id + '-options';

    return (
        <>
            <input
                id={id}
                className={className}
                style={style}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                aria-label="IANA timezone"
                placeholder="America/Los_Angeles"
                list={listId}
                autoComplete="off"
                spellCheck={false}
                required
                disabled={disabled}
            />
            <datalist id={listId}>
                {options.map((timezone) => <option key={timezone} value={timezone} />)}
            </datalist>
        </>
    );
}
