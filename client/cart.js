// Deterministic, serializable cart module
// Exposes global functions for legacy inline handlers: addToCart(id), removeFromCart(id), changeQty(id, delta), getCart(), getCartTotal(), clearCart()
(function(){
    let cart = []; // array of { product_id, name, price, quantity, line_total }
    let discountCode = '';
    let discountAmount = 0;

    function save() {
        try { localStorage.setItem('pos_cart', JSON.stringify({ cart, discountCode, discountAmount })); } catch(e){}
    }

    function load() {
        try { 
            const s = localStorage.getItem('pos_cart'); 
            if (s) {
                const data = JSON.parse(s);
                cart = data.cart || [];
                discountCode = data.discountCode || '';
                discountAmount = data.discountAmount || 0;
            }
        } catch(e){}
    }

    load();

    function recalc(item) {
        item.line_total = Number((item.price * item.quantity).toFixed(2));
    }

    function findIndex(product_id) {
        return cart.findIndex(i => Number(i.product_id) === Number(product_id));
    }

    function addToCart(productOrId) {
        let product = null;
        if (typeof productOrId === 'object') product = productOrId;
        else product = (window.products || []).find(p => Number(p.id) === Number(productOrId));
        if (!product) return false;

        const idx = findIndex(product.id);
        if (idx >= 0) {
            cart[idx].quantity += 1;
            recalc(cart[idx]);
            // Show toast for quantity increase
            if (typeof window.showToast === 'function') {
                window.showToast(`${product.name} quantity increased to ${cart[idx].quantity}`, 'success');
            }
        } else {
            const item = {
                product_id: product.id,
                name: product.name,
                price: Number(product.price),
                quantity: 1,
                line_total: Number(product.price)
            };
            cart.push(item);
            // Show toast for new item
            if (typeof window.showToast === 'function') {
                window.showToast(`${product.name} added to cart`, 'success');
            }
        }
        save();
        return true;
    }

    function removeFromCart(productId) {
        cart = cart.filter(i => Number(i.product_id) !== Number(productId));
        save();
    }

    function changeQty(productId, delta) {
        const idx = findIndex(productId);
        if (idx < 0) return;
        cart[idx].quantity = Math.max(0, cart[idx].quantity + delta);
        if (cart[idx].quantity === 0) cart.splice(idx,1);
        else recalc(cart[idx]);
        save();
    }

    function getCart() {
        // Return deep copy for safety
        return cart.map(i => ({ ...i }));
    }

    function getCartTotal() {
        return cart.reduce((s,i) => s + Number(i.line_total || (i.price * i.quantity || 0)), 0);
    }

    function clearCart() {
        cart = [];
        discountCode = '';
        discountAmount = 0;
        save();
    }

    function setDiscount(code, amount) {
        discountCode = code;
        discountAmount = amount;
        save();
    }

    function getDiscount() {
        return { code: discountCode, amount: discountAmount };
    }

    function getCartTotalWithDiscount() {
        return getCartTotal() - discountAmount;
    }

    // Expose simple globals for existing UI hooks
    window.addToCart = addToCart;
    window.removeFromCart = removeFromCart;
    window.changeQty = changeQty;
    window.getCart = getCart;
    window.getCartTotal = getCartTotal;
    window.clearCart = clearCart;
    window.setDiscount = setDiscount;
    window.getDiscount = getDiscount;
    window.getCartTotalWithDiscount = getCartTotalWithDiscount;

    // Also expose a namespaced Cart for imports if needed
    window.Cart = {
        addToCart, removeFromCart, changeQty, getCart, getCartTotal, clearCart
    };
})();
