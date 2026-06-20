<?php
/**
 * Plugin Name: Anna WooCommerce Integration
 * Description: CORS for anna.partners panel and Store API Cart-Token checkout bridge.
 * Version: 1.2.0
 */

// --- CORS: allow anna.partners to call the Store API from the panel iframe ---
add_filter('allowed_http_origins', function($origins) {
    $origins[] = 'https://anna.partners';
    return $origins;
});

add_action('rest_api_init', function() {
    remove_filter('rest_pre_serve_request', 'rest_send_cors_headers');
    add_filter('rest_pre_serve_request', function($served) {
        $origin = isset($_SERVER['HTTP_ORIGIN']) ? $_SERVER['HTTP_ORIGIN'] : '';
        $allowed = ['https://anna.partners', 'https://woo.isupercoder.com'];
        if (in_array($origin, $allowed, true)) {
            header('Access-Control-Allow-Origin: ' . $origin);
            header('Access-Control-Allow-Credentials: true');
            header('Access-Control-Allow-Methods: OPTIONS, GET, POST, PUT, PATCH, DELETE');
            header('Access-Control-Allow-Headers: Authorization, X-WP-Nonce, Content-Disposition, Content-MD5, Content-Type, Cart-Token, Nonce');
            // Nonce must be exposed so the panel iframe can read it cross-origin for cart writes.
            header('Access-Control-Expose-Headers: X-WP-Total, X-WP-TotalPages, Link, Cart-Token, Nonce');
        }
        if ('OPTIONS' === $_SERVER['REQUEST_METHOD']) {
            status_header(200);
            exit();
        }
        return $served;
    });
}, 15);

// --- Checkout bridge: map Store API Cart-Token session to WC PHP session cookie ---
add_action('init', function() {
    if (empty($_GET['anna_checkout'])) return;
    header('Cache-Control: no-store, no-cache, must-revalidate, private');
    header('Pragma: no-cache');
    $token = sanitize_text_field(wp_unslash($_GET['anna_checkout']));
    $parts = explode('.', $token);
    $sk = null;
    if (count($parts) === 3) {
        $pad = strlen($parts[1]) % 4;
        $b64 = strtr($parts[1] . ($pad ? str_repeat('=', 4 - $pad) : ''), '-_', '+/');
        $pl  = json_decode(base64_decode($b64), true);
        $sk  = $pl['user_id'] ?? null;
    }
    if ($sk && preg_match('/^t_[a-f0-9]+$/', $sk)) {
        $exp    = time() + 172800;
        $expiry = time() + 169200;
        // WP 6.8+ uses wp_fast_hash (sodium BLAKE2b); older WP uses hash_hmac('md5').
        // Must match WC_Session_Handler::hash() exactly or get_session_cookie() rejects it.
        $message = $sk . '|' . $exp;
        $hash = function_exists('wp_fast_hash')
            ? wp_fast_hash($message)
            : hash_hmac('md5', $message, wp_hash($message));
        $val  = $sk . '|' . $exp . '|' . $expiry . '|' . $hash;
        $name = apply_filters('woocommerce_cookie', 'wp_woocommerce_session_' . COOKIEHASH);
        header('X-Anna-Bridge: 1');
        wc_setcookie($name, $val, $exp, true, true);
    }
    wp_safe_redirect(wc_get_checkout_url());
    exit;
}, 1);
