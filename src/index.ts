// index.ts

import fetch from 'node-fetch';

// Discord webhook URL (provided)
const DISCORD_WEBHOOK_URL =
  'https://discord.com/api/webhooks/1341748074539651183/ezyLAzvDWy2mewzLQdQFKCcJw_i-baqpRugUifPdDsKdupCDuWCLRIDcBnF70CQCQ1uR';

// Base URL for DexScreener API
const BASE_API_URL = 'https://api.dexscreener.com';

// Polling interval (in milliseconds) - set to 60 seconds
const POLL_INTERVAL_MS = 60_000;

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

interface PairData {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  txns: {
    m5: {
      buys: number;
      sells: number;
    };
    [key: string]: any; // h1, h6, etc.
  };
  priceChange: {
    m5: number;
    [key: string]: number;
  };
  marketCap: number;
  info: {
    imageUrl: string;
    [key: string]: any;
  };
  // ... other fields like volume, liquidity, etc.
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
 * Using /token-profiles/latest/v1 as per DexScreener docs
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
  return (
    token.chainId.toLowerCase() === 'solana' ||
    token.url.startsWith('https://dexscreener.com/solana/')
  );
}

/**
 * Check if the given token (by contract address) has paid Dex.
 * Returns true if any order has status "approved".
 */
async function hasDexPaid(tokenAddress: string): Promise<boolean> {
  const url = `${BASE_API_URL}/orders/v1/solana/${tokenAddress}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Failed to fetch orders for ${tokenAddress}: ${res.statusText}`);
    return false;
  }
  const orders: Order[] = await res.json();

  // Optionally, only consider "recent" orders to skip older tokens:
  // const cutoff = Date.now() - 10 * 60_000; // last 10 minutes
  // const recentApproved = orders.find(
  //   (o) => o.status === 'approved' && o.paymentTimestamp > cutoff
  // );
  // return !!recentApproved;

  return orders.some((order) => order.status === 'approved');
}

/**
 * Fetch detailed token information from token-pairs endpoint.
 * The response is an array of pairs. We'll pick the first pair (or whichever you prefer).
 */
async function fetchTokenDetails(tokenAddress: string): Promise<TokenDetails> {
  const url = `${BASE_API_URL}/token-pairs/v1/solana/${tokenAddress}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch token details for ${tokenAddress}: ${res.statusText}`);
  }

  const pairs: PairData[] = await res.json();
  if (!pairs.length) {
    throw new Error(`No pairs found for token ${tokenAddress}`);
  }

  // For simplicity, pick the first pair. You could pick the pair with the highest liquidity, etc.
  const firstPair = pairs[0];
  const { baseToken, txns, priceChange, marketCap, info } = firstPair;

  // Map the pair data to our TokenDetails interface
  return {
    name: baseToken.name,
    symbol: baseToken.symbol,
    imageUrl: info.imageUrl,
    marketCap: marketCap,
    m5Buys: txns.m5.buys,
    m5Sells: txns.m5.sells,
    m5PriceChange: priceChange.m5,
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
          // Optional: If you only want new tokens, you can also check if the
          // paymentTimestamp is recent. If not, skip. (See commented code in hasDexPaid.)

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

// Start polling at regular intervals (1 minute)
setInterval(() => {
  processTokens();
}, POLL_INTERVAL_MS);

// Also run immediately on startup
processTokens();
