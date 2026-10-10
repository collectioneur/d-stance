import logo from "../assets/logo.png";

/**
 * "d-stance" where the d is the mark: a torus smooth-unioned with a link, rendered
 * by d-stance itself (Chrome mode) and cut out. Full-size: public/logo.png.
 */
export function Wordmark() {
  return (
    <span className="wordmark" aria-label="d-stance">
      <img className="wordmark-mark" src={logo} alt="" aria-hidden="true" />
      <span aria-hidden="true">
        <span className="wordmark-dot">-</span>stance
      </span>
    </span>
  );
}
