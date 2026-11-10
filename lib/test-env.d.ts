// Globals the test environment reads that no package declares.

// React reads this to decide whether `act()` warnings apply; tests set it
// before rendering (https://react.dev/reference/react/act).
declare var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
