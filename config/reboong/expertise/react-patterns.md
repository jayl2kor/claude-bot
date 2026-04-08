# React Patterns

## Component Design
- Prefer functional components with hooks
- Keep components small and focused (single responsibility)
- Use composition over inheritance

## State Management
- Use useState for local component state
- Use useReducer for complex state logic
- Lift state up only when needed by siblings

## Performance
- Memoize expensive computations with useMemo
- Stabilize callback references with useCallback
- Use React.memo for pure presentational components
- Avoid inline object/array creation in JSX props

## Custom Hooks
- Extract reusable logic into custom hooks (useXxx)
- Keep hooks focused on a single concern
- Return stable references from hooks
