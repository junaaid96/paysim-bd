import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'paysim-bd',
  description: 'Local-first simulator for Bangladeshi payment gateways.',
  base: '/paysim-bd/',
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: 'Quickstart', link: '/quickstart' },
      { text: 'Gateways', link: '/gateways/sslcommerz' },
      { text: 'Deploy', link: '/deploy' },
    ],
    sidebar: [
      {
        text: 'Start',
        items: [
          { text: 'What is paysim-bd?', link: '/' },
          { text: '60-second quickstart', link: '/quickstart' },
        ],
      },
      {
        text: 'Concepts',
        items: [
          { text: 'Scenarios', link: '/concepts/scenarios' },
          { text: 'Fake clock', link: '/concepts/clock' },
          { text: 'Callbacks & SSRF', link: '/concepts/callbacks' },
          { text: 'Refunds', link: '/concepts/refunds' },
          { text: 'Real sandbox (extra)', link: '/concepts/real-sandbox' },
        ],
      },
      {
        text: 'Gateways',
        items: [
          { text: 'SSLCommerz', link: '/gateways/sslcommerz' },
          { text: 'bKash', link: '/gateways/bkash' },
          { text: 'Nagad', link: '/gateways/nagad' },
          { text: 'Rocket', link: '/gateways/rocket' },
          { text: 'Upay', link: '/gateways/upay' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Management API', link: '/api' },
          { text: 'Parity suite', link: '/parity' },
          { text: 'Deploy (Render + Neon + R2)', link: '/deploy' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/junaaid96/paysim-bd' }],
    footer: {
      message: 'MIT licensed. Simulator only — never point it at real money.',
    },
  },
});
