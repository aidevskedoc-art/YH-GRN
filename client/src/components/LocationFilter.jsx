import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * The Location dropdown, on the results and CSD screens.
 *
 * Its options are the branches from the configuration screen, not the raw
 * Location text of any report. The GRN report writes a branch inside a longer
 * string -- "YASHODA HEALTHCARE SERVICES LIMITED, SECUNDERABAD" -- and the
 * ageing report does not write it at all, filing rows under a DivisionCode
 * instead; the configuration is the one place those two spellings are written
 * down as the same place. So the dropdown offers the place, and the server
 * turns the name back into both spellings (see branchPick).
 *
 * Only the ticked branches are offered while any are ticked. Ticking is what
 * scopes these screens, so an unticked branch has no rows on them at all, and
 * offering it would be offering a guaranteed empty table. With nothing ticked
 * nothing is scoped, and every configured branch is a real choice.
 *
 * The list is fetched here rather than passed in, because both screens want the
 * same list and neither has any other use for it. It is small, cached by the
 * browser like any other GET, and a failure to load it is not worth an error
 * banner on a page whose figures are fine -- the control simply goes quiet.
 *
 * An account confined to one branch gets that branch and nothing else, with no
 * "All locations" to go back to. The confinement is enforced on the server --
 * every query behind these screens carries it, whatever the dropdown says -- so
 * this is not the guard; it is the control telling the truth about what the
 * screen can show, rather than offering choices that would all return the same
 * rows.
 */
export default function LocationFilter({ value, onChange }) {
  const { user } = useAuth();
  const confinedTo = user?.branchLocation ?? null;

  const [locations, setLocations] = useState(null);

  useEffect(() => {
    // Nothing to choose from when the account is tied to one branch, so the
    // list is not worth a request.
    if (confinedTo) return undefined;
    let alive = true;
    api
      .listBranches()
      .then(({ branches }) => {
        if (!alive) return;
        const inScope = branches.some((b) => b.isSelected)
          ? branches.filter((b) => b.isSelected)
          : branches;
        // By name, deduplicated: two branch codes can share a location, and the
        // filter means the place rather than either of the codes under it.
        const names = [...new Set(inScope.map((b) => b.location).filter(Boolean))];
        names.sort((a, b) => a.localeCompare(b));
        setLocations(names);
      })
      .catch(() => {
        if (alive) setLocations([]);
      });
    return () => {
      alive = false;
    };
  }, [confinedTo]);

  const empty = locations !== null && locations.length === 0;

  if (confinedTo) {
    return (
      <label className="picker">
        <span className="picker__label">Location</span>
        <select
          className="field__input picker__input"
          value={confinedTo}
          disabled
          title={`This account sees ${confinedTo} only.`}
          onChange={() => {}}
        >
          <option value={confinedTo}>{confinedTo}</option>
        </select>
      </label>
    );
  }

  return (
    /* A labelled control, not a bare dropdown. It sits in the page head beside
       the upload selector -- the two together are the answer to "what am I
       looking at", which is a question worth naming rather than leaving to be
       inferred from whatever happens to be showing in the box. */
    <label className="picker">
      <span className="picker__label">Location</span>
      <select
        className="field__input picker__input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={empty}
        title={
          empty
            ? 'No branches configured yet — add them on the Configuration screen.'
            : 'Show one branch only'
        }
      >
        <option value="">All locations</option>
        {(locations ?? []).map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        {/* A location chosen before its branch was unticked or deleted would
            otherwise vanish from the list while still narrowing the table,
            which reads as the table having gone wrong. Keep it selectable
            until it is changed. */}
        {value && locations && !locations.includes(value) && (
          <option value={value}>{value}</option>
        )}
      </select>
    </label>
  );
}
