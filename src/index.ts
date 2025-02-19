// index.ts

import fetch from 'node-fetch';

// Discord webhook URL (provided)
const DISCORD_WEBHOOK_URL =
  'https://discord.com/api/webhooks/1341748074539651183/ezyLAzvDWy2mewzLQdQFKCcJw_i-baqpRugUifPdDsKdupCDuWCLRIDcBnF70CQCQ1uR';

// Base URL for DexScreener API
const BASE_API_URL = 'https://api.dexscreener.com';

// Polling interval (in milliseconds)
const POLL_INTERVAL_MS = 5_000;

// Keep track of tokens we've already alerted to avoid duplicates
const alertedContracts = new Set<string>();

// Type definitions for our responses

interface TokenProfile {
  url: string;
  chainId: string;
  tokenAddress: string;
  icon: string;
  header: string;
  openGraph: string;
  description: string;
  links: { type: string; url: string }[];
}

interface Order {
  type: string;
  status: string;
  paymentTimestamp: number;
}

interface TokenDetails {
  name: string;
  symbol: string;
  imageUrl: string;
  marketCap: number;
  m5Buys: number;
  m5Sells: number;
  m5PriceChange: number;
}

/**
 * Fetch the latest token profiles.
 * Using the correct endpoint: /token-profiles/latest/v1
 */
async function fetchLatestTokenProfiles(): Promise<TokenProfile[]> {
  const url = `${BASE_API_URL}/token-profiles/latest/v1`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch token profiles: ${res.statusText}`);
  }
  const data = await res.json();
  // Assuming the API returns an array of token profiles
  return data;
}

/**
 * Check if the token profile is a Solana token.
 */
function isSolanaToken(token: TokenProfile): boolean {
  return token.chainId.toLowerCase() === 'solana' ||
         token.url.startsWith('https://dexscreener.com/solana/');
}

/**
 * Check if the given token (by contract address) has paid Dex.
 * Returns true if any order has status "approved".
 */
async function hasDexPaid(tokenAddress: string): Promise<boolean> {
  // Ensure we don't add an extra slash in the URL.
  const url = `${BASE_API_URL}/orders/v1/solana/${tokenAddress}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Failed to fetch orders for ${tokenAddress}: ${res.statusText}`);
    return false;
  }
  const orders: Order[] = await res.json();
  return orders.some(order => order.status === 'approved');
}

/**
 * Fetch detailed token information from token-pairs endpoint.
 */
async function fetchTokenDetails(tokenAddress: string): Promise<TokenDetails> {
  const url = `${BASE_API_URL}/token-pairs/v1/solana/${tokenAddress}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch token details for ${tokenAddress}: ${res.statusText}`);
  }
  const details = await res.json();

  // Map the response to our TokenDetails interface.
  return {
    name: details.name,
    symbol: details.symbol,
    imageUrl: details.imageUrl,
    marketCap: details.marketCap,
    m5Buys: details.m5Buys,
    m5Sells: details.m5Sells,
    m5PriceChange: details.m5PriceChange,
  };
}

/**
 * Post an embedded message to Discord using the webhook.
 */
async function postToDiscord(tokenDetails: TokenDetails, tokenProfile: TokenProfile) {
  // Build the embed payload
  const embed = {
    title: '🚀 NEW TOKEN DEX PAID',
    description: `${tokenDetails.name} (${tokenDetails.symbol})`,
    thumbnail: { url: tokenDetails.imageUrl },
    fields: [
      {
        name: 'Market Cap',
        value: tokenDetails.marketCap ? `$${tokenDetails.marketCap}` : 'N/A',
        inline: true,
      },
      {
        name: 'M5 Buys / Sells',
        value: `${tokenDetails.m5Buys} / ${tokenDetails.m5Sells}`,
        inline: true,
      },
      {
        name: 'M5 Price Change',
        value:
          tokenDetails.m5PriceChange !== undefined
            ? `${tokenDetails.m5PriceChange.toFixed(2)}%`
            : 'N/A',
        inline: true,
      },
    ],
    footer: { text: `Contract: ${tokenProfile.tokenAddress}` },
    timestamp: new Date().toISOString(),
  };

  const payload = { embeds: [embed] };

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error(`Failed to post to Discord: ${res.statusText}`);
  } else {
    console.log(`Discord alert sent for token ${tokenDetails.name}`);
  }
}

/**
 * Process tokens:
 *  - Fetch latest tokens.
 *  - Filter for Solana tokens.
 *  - Check if each token has paid Dex.
 *  - If yes, fetch token details and post to Discord.
 *  - Track alerted token addresses to avoid duplicate notifications.
 */
async function processTokens() {
  try {
    const tokenProfiles = await fetchLatestTokenProfiles();
    for (const token of tokenProfiles) {
      if (!isSolanaToken(token)) continue;

      const tokenAddress = token.tokenAddress;
      if (alertedContracts.has(tokenAddress)) {
        // Already alerted for this token, skip.
        continue;
      }

      // Check if token has paid Dex
      const paid = await hasDexPaid(tokenAddress);
      if (paid) {
        try {
          const tokenDetails = await fetchTokenDetails(tokenAddress);
          await postToDiscord(tokenDetails, token);
          alertedContracts.add(tokenAddress);
        } catch (error) {
          console.error(`Error processing token ${tokenAddress}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('Error in processTokens:', error);
  }
}

// Start polling at regular intervals
setInterval(() => {
  processTokens();
}, POLL_INTERVAL_MS);

// Also run immediately on startup
processTokens();
