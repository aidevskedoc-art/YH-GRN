/**
 * Inline SVG icon set - deliberately dependency-free so the tool keeps working
 * on a hospital network with no CDN access. All icons share a 24x24 box and
 * inherit `currentColor`, so they take the colour of whatever they sit in.
 */

function Icon({ size = 18, children, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconUpload = (p) => (
  <Icon {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 9l5-5 5 5" />
    <path d="M12 4v12" />
  </Icon>
);

export const IconReport = (p) => (
  <Icon {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6" />
    <path d="M9 17h4" />
  </Icon>
);

export const IconPending = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.2 2" />
  </Icon>
);

export const IconLogout = (p) => (
  <Icon {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="M16 17l5-5-5-5" />
    <path d="M21 12H9" />
  </Icon>
);

export const IconMenu = (p) => (
  <Icon {...p}>
    <path d="M3 6h18" />
    <path d="M3 12h18" />
    <path d="M3 18h18" />
  </Icon>
);

export const IconChevronLeft = (p) => (
  <Icon {...p}>
    <path d="M15 5l-7 7 7 7" />
  </Icon>
);

export const IconChevronRight = (p) => (
  <Icon {...p}>
    <path d="M9 5l7 7-7 7" />
  </Icon>
);

export const IconChevronDown = (p) => (
  <Icon {...p}>
    <path d="M5 9l7 7 7-7" />
  </Icon>
);

export const IconSun = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
);

export const IconMoon = (p) => (
  <Icon {...p}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </Icon>
);

export const IconPlus = (p) => (
  <Icon {...p}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Icon>
);

export const IconDownload = (p) => (
  <Icon {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" />
    <path d="M12 15V3" />
  </Icon>
);

export const IconTrash = (p) => (
  <Icon {...p}>
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
  </Icon>
);

/* A paper plane, drawn as the outbound half of a send: the body, and the fold
   line down its middle that gives it a near and a far wing. */
export const IconSend = (p) => (
  <Icon {...p}>
    <path d="M21.5 2.5 11 13" />
    <path d="M21.5 2.5 15 21.5l-4-8.5-8.5-4z" />
  </Icon>
);

export const IconCheck = (p) => (
  <Icon {...p}>
    <path d="M20 6L9 17l-5-5" />
  </Icon>
);

export const IconAlert = (p) => (
  <Icon {...p}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Icon>
);

/* A workbook: the sheet, its folded corner, and two rules standing in for the
   grid. Used wherever a chosen .xls/.xlsx is shown back to the user. */
export const IconSheet = (p) => (
  <Icon {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
    <path d="M8.5 13h7" />
    <path d="M8.5 17h4.5" />
  </Icon>
);

export const IconX = (p) => (
  <Icon {...p}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Icon>
);

export const IconArrowRight = (p) => (
  <Icon {...p}>
    <path d="M4 12h15" />
    <path d="m13 6 6 6-6 6" />
  </Icon>
);

/* Two people: the account in front, and the shoulder of a second behind it.
   The user management screen, in the sidebar and on its own page head. */
export const IconUsers = (p) => (
  <Icon {...p}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Icon>
);

/* A pencil over its stroke -- editing an account in place. */
export const IconPencil = (p) => (
  <Icon {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
  </Icon>
);

/* A key: the bow, and the two wards on its bit. Resetting a password. */
export const IconKey = (p) => (
  <Icon {...p}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="M10.8 12.2 21 2" />
    <path d="m17 6 2.5 2.5" />
    <path d="m14 9 2.5 2.5" />
  </Icon>
);

/* A shield: the role badge on an administrator's row. */
export const IconShield = (p) => (
  <Icon {...p}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </Icon>
);

/* A padlock, closed. Marks a control this account may look at but not use. */
export const IconLock = (p) => (
  <Icon {...p}>
    <rect x="4" y="10.5" width="16" height="10.5" rx="2" />
    <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
  </Icon>
);

/* A sliders panel: settings that are set once and left. Deliberately not a
   cogwheel -- that reads as "preferences for me", and these are installation
   settings that change what everyone sees. */
export const IconSliders = (p) => (
  <Icon {...p}>
    <path d="M4 6h10M18 6h2" />
    <path d="M4 12h4M12 12h8" />
    <path d="M4 18h12M20 18h0" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="18" cy="18" r="2" />
  </Icon>
);

/* An office block: the CS department as a place, since a nav entry is a
   destination. Deliberately not the paper plane -- IconSend is the "hand over"
   action in the results table, and the same glyph in the rail would read as a
   second copy of that button rather than the screen it lands on. */
export const IconDepartment = (p) => (
  <Icon {...p}>
    <path d="M3 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16" />
    <path d="M14 10h6a1 1 0 0 1 1 1v10" />
    <path d="M2 21h20" />
    <path d="M6.5 8h3" />
    <path d="M6.5 12h3" />
    <path d="M17 14h1.5" />
    <path d="M8 21v-3.5a1.5 1.5 0 0 1 3 0V21" />
  </Icon>
);

/**
 * The Accounts Department: a bank front, the destination the PR-to-Bank ageing is
 * measured to. Distinct at 18px from IconDepartment's office block beside it in
 * the sidebar -- a pediment and columns rather than two flat-roofed boxes.
 */
/** Take back: an arrow curling back on itself, for undoing a send. */
export const IconUndo = (p) => (
  <Icon {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Icon>
);

/** Activity logs: a pulse line, for the admin's monitoring screen. */
export const IconActivity = (p) => (
  <Icon {...p}>
    <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
  </Icon>
);

export const IconBank = (p) => (
  <Icon {...p}>
    <path d="M3 10h18" />
    <path d="M12 3 3 7.5h18L12 3Z" />
    <path d="M6 10v8" />
    <path d="M10 10v8" />
    <path d="M14 10v8" />
    <path d="M18 10v8" />
    <path d="M3 21h18" />
  </Icon>
);

/* An open eye: the password is being shown. */
export const IconEye = (p) => (
  <Icon {...p}>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

/* The same eye struck through: the password is hidden. The lid is drawn as two
   arcs broken by the stroke rather than one closed shape, so the glyph still
   reads as an eye at 17px where a solid outline would fill in. */
export const IconEyeOff = (p) => (
  <Icon {...p}>
    <path d="M10.7 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a18.6 18.6 0 0 1-3.2 4.1" />
    <path d="M6.6 6.6A18.4 18.4 0 0 0 2 12s3.6 7 10 7a10.3 10.3 0 0 0 4.4-.95" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="m3 3 18 18" />
  </Icon>
);

/* Two lists held against each other: the MSME reco, the vendor master beside
   the Accounts list, with the arrows between them saying they are compared. */
export const IconCompare = (p) => (
  <Icon {...p}>
    <rect x="3" y="4" width="6" height="16" rx="1.5" />
    <rect x="15" y="4" width="6" height="16" rx="1.5" />
    <path d="M10.5 9h3m-1.2-1.6L13.5 9l-1.2 1.6" />
    <path d="M13.5 15h-3m1.2-1.6L10.5 15l1.2 1.6" />
  </Icon>
);
