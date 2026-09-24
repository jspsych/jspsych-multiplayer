import React, { type ReactNode } from "react";
import clsx from "clsx";
import styles from "./styles.module.css";

/**
 * A numbered walkthrough. `<Steps>` renders an ordered list with a connecting
 * rail; each `<Step>` is one item. Modelled on the component in the
 * jspsych/metadata and jspsych-multiplayer websites.
 *
 * Write each step's title as an ordinary Markdown heading inside the `<Step>`,
 * rather than as a prop: only real headings reach the table of contents, and on
 * a page with no left sidebar the table of contents is how the steps are
 * navigated. `title` stays available for a step that should not be listed.
 */
export function Steps({ children }: { children: ReactNode }): ReactNode {
  // `role="list"` is required because `list-style: none` strips list semantics in
  // Safari/VoiceOver, which would silently drop the "step 3 of 8" announcement.
  return (
    <ol className={styles.steps} role="list">
      {children}
    </ol>
  );
}

export function Step({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <li className={clsx(styles.step, className)}>
      {title ? <h3 className={styles.stepTitle}>{title}</h3> : null}
      <div className={styles.stepBody}>{children}</div>
    </li>
  );
}
