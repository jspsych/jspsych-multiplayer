import React from "react";
import clsx from "clsx";
import Layout from "@theme/Layout";
import CodeBlock from "@theme/CodeBlock";
import Link from "@docusaurus/Link";
import { JspsychBrain } from "@jspsych/docusaurus-theme/components";
import styles from "./index.module.css";

/** Stroke icons, drawn to the same 24×24 / 1.75-weight grid as the other jsPsych sites. */
function Icon({
  className,
  size = 24,
  children,
}: {
  className?: string;
  size?: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const TabsIcon = ({ className }: { className?: string }) => (
  <Icon className={className} size={20}>
    <rect x="2.5" y="5" width="12" height="10" rx="1.5" />
    <path d="M9.5 19h10a2 2 0 0 0 2-2V9" />
  </Icon>
);

const CodeIcon = ({ className }: { className?: string }) => (
  <Icon className={className} size={20}>
    <polyline points="8 6 3 12 8 18" />
    <polyline points="16 6 21 12 16 18" />
  </Icon>
);

const BarrierIcon = ({ className }: { className?: string }) => (
  <Icon className={className} size={28}>
    <line x1="14" y1="3" x2="14" y2="21" />
    <polyline points="3 7 9 7" />
    <polyline points="3 12 11 12" />
    <polyline points="3 17 7 17" />
    <polyline points="17 12 21 12" />
    <polyline points="19 10 21 12 19 14" />
  </Icon>
);

const LiveIcon = ({ className }: { className?: string }) => (
  <Icon className={className} size={28}>
    <path d="M4 5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3H4" />
    <path d="M20 9v6a2 2 0 0 1-2 2" />
  </Icon>
);

const SwapIcon = ({ className }: { className?: string }) => (
  <Icon className={className} size={28}>
    <polyline points="16 3 20 7 16 11" />
    <line x1="4" y1="7" x2="20" y2="7" />
    <polyline points="8 21 4 17 8 13" />
    <line x1="20" y1="17" x2="4" y2="17" />
  </Icon>
);

function Hero(): React.ReactElement {
  return (
    <header className={styles.hero}>
      <div className={styles.heroRow}>
        <div className={styles.heroCopy}>
          {/* `navbar__brand` is the hover hook that animates the dot-brain; see the
              theme's JspsychBrain component. */}
          <span className={clsx("navbar__brand", styles.heroLogo)}>
            <JspsychBrain className={styles.heroMark} />
          </span>
          <div className={styles.heroText}>
            <h1 className={styles.heroTitle}>
              <span className={styles.heroTitleAccent}>jsPsych Multiplayer</span>{" "}
              runs experiments where participants interact.
            </h1>
            <p className={styles.heroLede}>
              Two or more people take part in the same session and see each
              other's choices: an ultimatum game, a public-goods game, a group
              chat, a shared drawing, a reference game.
            </p>
            <p className={styles.heroNote}>
              These are ordinary jsPsych plugins. You keep your stimuli, your
              other plugins and your data pipeline, and add a few trials that
              wait for the group or show what others are doing.
            </p>
          </div>
        </div>

        <div className={styles.heroPaths}>
          <div className={styles.pathList}>
            <div className={styles.pathCard}>
              <div className={styles.pathCardHead}>
                <TabsIcon className={styles.pathCardIcon} />
                <h2 className={styles.pathCardTitle}>Try it in two tabs</h2>
              </div>
              <p className={styles.pathCardDesc}>
                Build a two-player experiment in one HTML file and play both
                sides from two tabs of your browser. No server and no account.
              </p>
              <div className={styles.pathCardActions}>
                <Link className={styles.pathLink} to="/getting-started">
                  Getting started →
                </Link>
              </div>
            </div>

            <div className={styles.pathCard}>
              <div className={styles.pathCardHead}>
                <CodeIcon className={styles.pathCardIcon} />
                <h2 className={styles.pathCardTitle}>Start from a working game</h2>
              </div>
              <p className={styles.pathCardDesc}>
                Chat rooms, polls, matching, a public-goods game, a tangram
                reference game and more, each a single file you can copy.
              </p>
              <div className={styles.pathCardActions}>
                <Link className={styles.pathLink} to="/examples">
                  Browse the examples →
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

function Features(): React.ReactElement {
  return (
    <section className={styles.features}>
      <p className={styles.eyebrow}>What it does</p>
      <div className={styles.featureGrid}>
        <div>
          <BarrierIcon className={styles.featureIcon} />
          <h2 className={styles.featureTitle}>Waiting for the group</h2>
          <p className={styles.featureBody}>
            A trial shares a value, such as an offer, then waits until the group
            meets a condition, such as the partner having replied. Lobbies,
            role assignment, pairing and simultaneous choices are each one
            trial.
          </p>
        </div>
        <div>
          <LiveIcon className={styles.featureIcon} />
          <h2 className={styles.featureTitle}>Live interaction</h2>
          <p className={styles.featureBody}>
            Chat, a shared canvas and a director–matcher reference game update
            on every screen as participants act. Everything they send is
            recorded in the trial data.
          </p>
        </div>
        <div>
          <SwapIcon className={styles.featureIcon} />
          <h2 className={styles.featureTitle}>Any backend</h2>
          <p className={styles.featureBody}>
            Develop in two browser tabs, then collect data through JATOS or
            Firebase. The backend is one line of your experiment, and nothing
            else changes when you swap it.
          </p>
        </div>
      </div>
    </section>
  );
}

const TIMELINE_SAMPLE = `const jsPsych = initJsPsych();

const lobby = {
  type: jsPsychMultiplayerSync,
  wait_for: (group, presence) =>
    Object.values(presence).filter((p) => p === "connected").length >= 2,
  message: "Waiting for a partner…",
};

const roles = {
  type: jsPsychMultiplayerRole,
  roles: ["proposer", "responder"],
  group_size: 2,
};

jsPsych.multiplayer
  .connect(new jsPsychAdapterMultiplayerLocal())
  .then(() => jsPsych.run([lobby, roles /* , your trials */]));`;

function InYourTimeline(): React.ReactElement {
  return (
    <section className={styles.timeline}>
      <div className={styles.timelineCard}>
        <div className={styles.timelineText}>
          <p className={styles.eyebrow}>Example</p>
          <h2 className={styles.timelineTitle}>A lobby and two roles</h2>
          <p className={styles.timelineBody}>
            Connect a backend before the timeline runs. After that, multiplayer
            trials go in your timeline like any other: here, a lobby that waits
            for two people, then a trial that makes one the proposer and the
            other the responder.
          </p>
          <Link className="button button--primary" to="/guides/ultimatum-game">
            Build the full game →
          </Link>
        </div>
        <div className={styles.timelineCode}>
          <CodeBlock language="js">{TIMELINE_SAMPLE}</CodeBlock>
        </div>
      </div>
    </section>
  );
}

const PLUGINS = [
  { name: "multiplayer-sync", what: "Share a value, then wait until the group meets a condition." },
  { name: "multiplayer-ready", what: "A ready button that holds everyone until the group has checked in." },
  { name: "multiplayer-role", what: "Assign roles, the same on every screen." },
  { name: "multiplayer-match", what: "Split the group into pairs or other sub-groups." },
  { name: "multiplayer-choice", what: "Everyone chooses at once, then sees what the others chose." },
  { name: "multiplayer-scoreboard", what: "Rank every player's final score." },
  { name: "multiplayer-countdown", what: "One timer, in step on every screen." },
  { name: "multiplayer-chat", what: "A live chat room." },
  { name: "multiplayer-draw", what: "A shared drawing canvas." },
  { name: "multiplayer-reference-game", what: "A director–matcher reference game, such as tangrams." },
];

const ADAPTERS = [
  { name: "adapter-multiplayer-local", what: "Tabs in one browser. For building and testing; no server." },
  { name: "adapter-multiplayer-jatos", what: "JATOS group studies, on your lab's JATOS server." },
  { name: "adapter-multiplayer-firebase", what: "Firebase Realtime Database. Cross-device, with no server to run." },
];

function Details(): React.ReactElement {
  return (
    <section className={styles.details}>
      <div className={styles.detailsGrid}>
        <div>
          <p className={styles.eyebrow}>Plugins</p>
          <ul className={styles.packageList}>
            {PLUGINS.map((p) => (
              <li key={p.name}>
                <Link className={styles.packageName} to={`/reference/plugin-${p.name}`}>
                  {p.name}
                </Link>
                <span className={styles.packageWhat}>{p.what}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className={styles.eyebrow}>Backends</p>
          <ul className={styles.packageList}>
            {ADAPTERS.map((a) => (
              <li key={a.name}>
                <Link className={styles.packageName} to={`/reference/${a.name}`}>
                  {a.name}
                </Link>
                <span className={styles.packageWhat}>{a.what}</span>
              </li>
            ))}
          </ul>
          <p className={styles.detailsNote}>
            Not sure which to use? See{" "}
            <Link to="/guides/choosing-a-backend">Choosing a backend</Link>.
          </p>
        </div>
      </div>
    </section>
  );
}

export default function Home(): React.ReactElement {
  return (
    <Layout description="jsPsych Multiplayer runs jsPsych experiments where two or more participants take part in the same session at the same time. It provides plugins for lobbies, roles, group choices, chat and shared drawing, and backends for JATOS and Firebase.">
      <main>
        <Hero />
        <Features />
        <InYourTimeline />
        <Details />
      </main>
    </Layout>
  );
}
