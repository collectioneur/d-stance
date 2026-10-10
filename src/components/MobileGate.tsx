import { useRef, useState } from "react";
import { COPIED_ICON, COPY_LINK_ICON } from "../utils/commands";
import { Wordmark } from "./Wordmark";
import LogoSpinner from "./LogoSpinner";

/** Full-screen notice for windows too narrow for the editor (phones, split screens). */
export default function MobileGate() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The URL carries the scene, so the link reopens it on a desktop.
  function copyLink() {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="mobile-gate">
      <div className="mobile-gate-card">
        <Wordmark />
        <LogoSpinner />
        <h1 className="mobile-gate-title">Made for desktop</h1>
        <p className="mobile-gate-text">
          d-stance is a 3D editor built for a mouse and a large screen. Open it on a
          computer, or make this window wider.
        </p>
        <button type="button" className="mobile-gate-btn" onClick={copyLink}>
          {copied ? <COPIED_ICON size={14} /> : <COPY_LINK_ICON size={14} />}
          {copied ? "Link copied" : "Copy link"}
        </button>
      </div>
    </div>
  );
}
