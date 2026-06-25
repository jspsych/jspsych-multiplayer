# jspsych-multiplayer: community plugins & adapters for the jsPsych multiplayer API

This is an open repository of **plugins** and **adapters** developed by members of the jsPsych
community that target the [jsPsych multiplayer API](https://github.com/jspsych/jsPsych/pull/3692).
If you've written a multiplayer plugin or a backend adapter that you think others might be
interested in using, this is the place to share it!

## What is the multiplayer API?

jsPsych supports opt-in, real-time multiplayer experiments through a two-layer architecture:

- A high-level **`MultiplayerAPI`** on `jsPsych.pluginAPI` for pushing data, subscribing to group
  session changes, and waiting on conditions. It is backend-agnostic — all network logic lives in a
  swappable adapter.
- A swappable **`MultiplayerAdapter`** that implements the network I/O for a specific backend
  (`connect`, `push`, `getAll`, `get`, `subscribe`, `disconnect`).

Two kinds of community contributions build on this:

- **Plugins** — trial plugins built on top of the multiplayer API (for example, a synchronization
  barrier that pushes participant data and waits until a group condition is satisfied).
- **Adapters** — implementations of the `MultiplayerAdapter` interface for a particular backend
  (JATOS group sessions, Firebase, a custom WebSocket server, etc.).

## `jspsych` vs. `jspsych-multiplayer`

The multiplayer API itself, along with a reference plugin and adapter, lives in the
[main `jsPsych` repository](https://github.com/jspsych/jsPsych/) and is maintained by the core
jsPsych team.

Plugins and adapters in this `jspsych-multiplayer` repository are contributed by community members.
They are not extensively tested or verified by the core jsPsych team, and there is no guarantee that
anyone will be available to fix bugs, push updates, or answer questions about them. However we would
encourage contributors to respond to issues/questions and to maintain their code.

Contributions to `jspsych-multiplayer` that are broadly useful, well-documented, and well-tested may
be added to the main `jsPsych` repository, with the contributor's permission.

## List of available plugins and adapters

The contributed packages can be found in the `/packages` directory. Plugins are published under the
`@jspsych-multiplayer/plugin-*` names and adapters under the `@jspsych-multiplayer/adapter-*` names.

### Plugins

Plugin | Contributor | Description
----------- | ----------- | -----------


### Adapters

Adapter | Contributor | Description
----------- | ----------- | -----------

## Guidelines for contributions
### Contribution requirements
Contributions to this repository must:

* Work as described
* Include the complete code for the plugin or adapter.
* Include a `README.md` file following our template (identical for plugins and adapters).
* Include a `package.json` file.

Optionally, contributions are encouraged to include:

* A `/docs` directory with documentation matching the template for docs on jspsych.org.
* An `/examples` directory with a working `.html` demo.
* A test suite following the testing framework in our `-ts` templates.

### To contribute a new plugin or adapter to this repository, follow these steps:
1. Clone this repository on your machine and run `npm i` to install its packages.
2. Scaffold a new package under `/packages`:
   * For a **plugin**, run `npx @jspsych/new-plugin` and answer the prompts.
   * For an **adapter**, run `npx @jspsych/new-multiplayer-adapter` and answer the prompts.

   These are command-line tools we built to make setting up the development of a new
   plugin/adapter easier. When run from inside this repository they automatically use the
   `@jspsych-multiplayer` npm scope and create the package under `/packages`.
3. After you are done editing the template, verify that it works by opening `examples/index.html`
   in your browser.
4. Run `npm i` in your plugin/adapter directory to install all your dependencies.
5. Add a changeset by running `npm run changeset` in the main directory of the repository. This will
   prompt you for a description of the changes you made and creates a new changeset file in the
   `.changeset` directory accordingly.
6. Open a pull request to merge your branch into the `main` branch of this repository.

In the pull request comments, please make it clear how we can verify that the contribution is
functional. This could be accomplished with a link to a demonstration experiment, the inclusion of
an example file and/or testing files, or through some other means. We try to review pull requests
quickly and add new contributions as soon as the minimal standards are met.

## Creating a new plugin or adapter

We have tools for building new plugins and adapters at
[jspsych-dev](https://github.com/jspsych/jspsych-dev/tree/main), with instructions for using the
tools in the repository's [`README.md`](https://github.com/jspsych/jspsych-dev/blob/main/README.md).

You may also want to read the jsPsych documentation on
[plugin development](https://www.jspsych.org/latest/developers/plugin-development/) to understand how
to work with the `index.ts` file, and the multiplayer
[adapter development guide](https://github.com/jspsych/jsPsych/blob/main/docs/developers/adapter-development.md)
to understand how to implement the `MultiplayerAdapter` interface.

## jsPsych version compatibility

The multiplayer API is available in jsPsych v8+. We encourage you to contribute plugins and adapters
that are compatible with the latest version of jsPsych, as this will make your contributions
maximally accessible to other jsPsych users. If you have suggestions/requests for additional
documentation, please open a thread on our
[discussion board](https://github.com/jspsych/jsPsych/discussions/).
