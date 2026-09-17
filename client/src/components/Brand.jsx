/**
 * The hospital mark comes in two forms:
 *  - `yashoda-logo.png` is the shipped app icon (orange flower on a white
 *    rounded tile); it is served straight from /public as the favicon.
 *  - `yashoda-mark.png` is the same flower with the white knocked out, so it
 *    sits directly on the dark chrome without carrying a white square with it.
 */
import markUrl from '../assets/yashoda-mark.png';

export { markUrl };

export function LogoMark({ size = 32, className }) {
  return (
    <img src={markUrl} width={size} height={size} alt="" className={className} draggable={false} />
  );
}

/**
 * Mark plus wordmark. `onDark` flips the type to white for the dark surfaces
 * (sidebar, login panel); `subtitle` names the product beneath the hospital.
 */
export function BrandLockup({ size = 32, onDark = false, subtitle = 'GRN Reconciliation', showText = true }) {
  return (
    <div className={`brand-lockup${onDark ? ' on-dark' : ''}`}>
      <LogoMark size={size} />
      {showText && (
        <div className="brand-text">
          <span className="brand-name">Yashoda Hospitals</span>
          {/* {subtitle && <span className="brand-sub">{subtitle}</span>} */}
        </div>
      )}
    </div>
  );
}
