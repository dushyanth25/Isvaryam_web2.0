import {
  PayPalButtons,
  PayPalScriptProvider,
  usePayPalScriptReducer,
} from '@paypal/react-paypal-js';
import React, { useEffect, useState } from 'react';
import { useLoading } from '../../hooks/useLoading';
import { pay } from '../../services/orderService';
import { useCart } from '../../hooks/useCart';
import { toast } from 'react-toastify';
import { useNavigate } from 'react-router-dom';

export default function PaypalButtons({ order }) {
  const clientId = process.env.REACT_APP_PAYPAL_CLIENT_ID;
  const [usdPrice, setUsdPrice] = useState(null);

  // ✅ fetch INR → USD conversion rate dynamically
  useEffect(() => {
    async function fetchRate() {
      try {
        const res = await fetch(
          "https://api.exchangerate.host/convert?from=INR&to=USD"
        );
        const data = await res.json();
        const rate = data?.info?.rate || 0.012; // fallback to ~0.012
        setUsdPrice((order.totalPrice * rate).toFixed(2));
      } catch (err) {
        console.error("Currency conversion failed:", err);
        // fallback approx
        setUsdPrice((order.totalPrice * 0.012).toFixed(2));
      }
    }
    fetchRate();
  }, [order.totalPrice]);

  if (!usdPrice) return <div>Loading PayPal...</div>;

  console.log("ENV Check:", process.env);
  console.log("PayPal Client ID:", clientId);
  console.log("INR:", order.totalPrice, "→ USD:", usdPrice);

  return (
    <PayPalScriptProvider
      options={{
        "client-id": clientId,
        currency: "USD", // ✅ use USD in PayPal
      }}
    >
      <Buttons order={order} usdPrice={usdPrice} />
    </PayPalScriptProvider>
  );
}

function Buttons({ order, usdPrice }) {
  const { clearCart } = useCart();
  const navigate = useNavigate();
  const [{ isPending }] = usePayPalScriptReducer();
  const { showLoading, hideLoading } = useLoading();

  useEffect(() => {
    isPending ? showLoading() : hideLoading();
  }, [isPending, showLoading, hideLoading]);

  const createOrder = (data, actions) => {
    return actions.order.create({
      purchase_units: [
        {
          description: `Order Payment (₹${order.totalPrice})`, // optional
          amount: {
            currency_code: 'USD', // ✅ PayPal accepts USD
            value: usdPrice,
          },
        },
      ],
    });
  };

  const onApprove = async (data, actions) => {
    try {
      const payment = await actions.order.capture();
      const orderId = await pay(payment.id);
      clearCart();
      toast.success('Payment Saved Successfully');
      navigate('/track/' + orderId);
    } catch (error) {
      toast.error('Payment Save Failed');
      console.error(error);
    }
  };

  const onError = (err) => {
    toast.error('Payment Failed');
    console.error('PayPal Error:', err);
  };

  return (
    <PayPalButtons
      style={{ layout: "vertical" }}
      createOrder={createOrder}
      onApprove={onApprove}
      onError={onError}
    />
  );
}
