import { useId, useState } from 'react';
import { IconEye, IconEyeOff } from './icons.jsx';

/**
 * A password field with a reveal toggle.
 *
 * The toggle lives INSIDE the field's border rather than beside it, so the
 * control keeps the same footprint as every other `.field` on the form and
 * nothing shifts when it appears.
 *
 * It renders its own label instead of being wrapped in one, because a `<label>`
 * may not contain interactive content other than the control it names: a button
 * nested in the label would forward its click to the input as well, and the
 * reveal would fight the caret for the same tap.
 *
 * Whatever is passed through lands on the input (`value`, `onChange`,
 * `autoComplete`, `required`, `minLength`, `autoFocus`, ...), so the call sites
 * read the same as the plain `.field__input` they replace.
 */
export default function PasswordField({ label, hint, id, className = 'field', ...inputProps }) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const [shown, setShown] = useState(false);
  const action = shown ? 'Hide password' : 'Show password';

  return (
    <div className={className}>
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      <div className="field__reveal">
        <input
          {...inputProps}
          id={inputId}
          className="field__input"
          type={shown ? 'text' : 'password'}
        />
        <button
          type="button"
          className="field__reveal-btn"
          onClick={() => setShown((s) => !s)}
          aria-label={action}
          aria-pressed={shown}
          title={action}
        >
          {shown ? <IconEyeOff size={17} /> : <IconEye size={17} />}
        </button>
      </div>
      {hint && <span className="field__hint">{hint}</span>}
    </div>
  );
}
