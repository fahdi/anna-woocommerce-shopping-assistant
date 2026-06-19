<?php
/**
 * Plugin Name: Anna Checkout Bridge
 * Description: Bridges Store API Cart-Token session to WooCommerce PHP session cookie for checkout.
 * Version: 1.1.0
 */

add_action( 'init', function () {
    if ( empty( $_GET['anna_checkout'] ) ) return;

    // Never let CDN cache this redirect — each request must hit PHP.
    header( 'Cache-Control: no-store, no-cache, must-revalidate, private' );
    header( 'Pragma: no-cache' );

    $token  = sanitize_text_field( wp_unslash( $_GET['anna_checkout'] ) );
    $parts  = explode( '.', $token );
    $session_key = null;

    if ( count( $parts ) === 3 ) {
        $pad     = strlen( $parts[1] ) % 4;
        $b64     = strtr( $parts[1] . ( $pad ? str_repeat( '=', 4 - $pad ) : '' ), '-_', '+/' );
        $payload = json_decode( base64_decode( $b64 ), true );
        $session_key = $payload['user_id'] ?? null;
    }

    if ( $session_key && preg_match( '/^t_[a-f0-9]+$/', $session_key ) ) {
        // WooCommerce session cookie format (class-wc-session-handler.php set_customer_session_cookie):
        // customer_id || session_expiration || session_expiring || cookie_hash
        // HMAC key: wp_hash(customer_id|session_expiration)
        $session_expiration = time() + 48 * HOUR_IN_SECONDS;
        $session_expiring   = time() + 47 * HOUR_IN_SECONDS;
        $to_hash            = $session_key . '|' . $session_expiration;
        $cookie_hash        = hash_hmac( 'md5', $to_hash, wp_hash( $to_hash ) );
        $cookie_val         = $session_key . '||' . $session_expiration . '||' . $session_expiring . '||' . $cookie_hash;
        $cookie_name        = apply_filters( 'woocommerce_cookie', 'wp_woocommerce_session_' . COOKIEHASH );
        wc_setcookie( $cookie_name, $cookie_val, $session_expiration, true, true );
    }

    wp_safe_redirect( wc_get_checkout_url() );
    exit;
}, 1 );
