// Stub: Task 6 builds the real UI.
import './styles.css';
import type { PropsToHost } from '../../properties/protocol';

declare function acquireVsCodeApi(): { postMessage(m: PropsToHost): void };
acquireVsCodeApi().postMessage({ type: 'ready' });
