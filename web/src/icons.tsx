// Small inline icon set (stroke icons, 16px grid).
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size = 14) => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export const IconPin = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M10.5 1.8l3.7 3.7-2.3 1-2.6 2.6.3 3.1-1.3 1.3-2.4-2.4L2.5 14.5M5.9 11.1L3.5 8.7l1.3-1.3 3.1.3 2.6-2.6z" />
  </svg>
);
export const IconGate = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 1.8L14.2 8 8 14.2 1.8 8z" />
    <path d="M8 5.2v3.3M8 10.6v.1" />
  </svg>
);
export const IconCheck = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M3 8.5l3.2 3L13 4.5" />
  </svg>
);
export const IconChat = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M2.5 3.5h11v7.2H7l-3 2.6v-2.6H2.5z" />
  </svg>
);
export const IconBot = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <rect x="2.5" y="5" width="11" height="8" rx="2.2" />
    <path d="M8 5V2.6M6 8.6v.6M10 8.6v.6M6.2 11h3.6" />
  </svg>
);
export const IconUser = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="8" cy="5.4" r="2.7" />
    <path d="M2.8 14c.6-2.8 2.7-4.3 5.2-4.3s4.6 1.5 5.2 4.3" />
  </svg>
);
export const IconSearch = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </svg>
);
export const IconPlus = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 3v10M3 8h10" />
  </svg>
);
export const IconX = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);
export const IconFocus = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5" />
    <circle cx="8" cy="8" r="2" />
  </svg>
);
export const IconGrip = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01" strokeWidth="2.4" />
  </svg>
);
export const IconBolt = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M9 1.8L3.5 9h4l-1 5.2L12.5 7h-4z" />
  </svg>
);
export const IconQuestion = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M6.2 6.2a1.9 1.9 0 113 1.5c-.8.5-1.2.9-1.2 1.8M8 11.6v.1" />
  </svg>
);
export const IconArrowRight = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M2.5 8h11M9.5 4l4 4-4 4" />
  </svg>
);
export const IconLayers = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 2l6 3.2-6 3.2-6-3.2zM2 8.3l6 3.2 6-3.2M2 11.2l6 3.2 6-3.2" />
  </svg>
);
export const IconCopy = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
    <path d="M10.5 5.5V3.6c0-.6-.5-1.1-1.1-1.1H3.6c-.6 0-1.1.5-1.1 1.1v5.8c0 .6.5 1.1 1.1 1.1h1.9" />
  </svg>
);
export const IconChevron = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M6 3.5L10.5 8 6 12.5" />
  </svg>
);
export const IconPen = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M10.8 2.7l2.5 2.5L6 12.5l-3.2.7.7-3.2z" />
  </svg>
);
export const IconTarget = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <circle cx="8" cy="8" r="2" />
  </svg>
);
export const IconArrowLeft = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M13.5 8h-11M6.5 4l-4 4 4 4" />
  </svg>
);
