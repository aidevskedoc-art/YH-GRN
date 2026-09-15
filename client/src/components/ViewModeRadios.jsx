import { useId } from 'react';
import { ACCOUNTS_CHEQUE_VIEW, ACCOUNTS_GRN_VIEW } from '../services/resultsViews.js';

const OPTIONS = [
  { value: ACCOUNTS_GRN_VIEW, label: 'GRNs' },
  { value: ACCOUNTS_CHEQUE_VIEW, label: 'Cheques' },
];

/**
 * The GRNs / Cheques switch, as two radio buttons captioned like the pickers
 * beside it. Shared by the results screen's Accounts view, the Accounts Department
 * and the CS Department screen, so all three read and behave alike.
 */
export default function ViewModeRadios({ value, onChange, label = 'Show by' }) {
  const id = useId();
  return (
    <div className="picker">
      <span className="picker__label" id={`${id}-label`}>
        {label}
      </span>
      <div className="view-radios" role="radiogroup" aria-labelledby={`${id}-label`}>
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className={`view-radios__option ${value === option.value ? 'is-active' : ''}`}
          >
            <input
              type="radio"
              name={`${id}-view`}
              value={option.value}
              checked={value === option.value}
              onChange={(e) => onChange(e.target.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </div>
  );
}
