import { Router } from 'express';
import handler from 'express-async-handler';
import axios from 'axios'; // Add axios for HTTP requests
import auth from '../middleware/auth.mid.js';
import { BAD_REQUEST, UNAUTHORIZED } from '../constants/httpStatus.js';
import { OrderModel } from '../models/order.model.js';
import { PaymentModel } from '../models/payment.model.js';
import { OrderStatus } from '../constants/orderStatus.js';
import { UserModel } from '../models/user.model.js';
import { sendEmailReceipt } from '../helpers/mail.helper.js';
import { FoodModel } from '../models/food.model.js';
import admin from '../middleware/admin.mid.js';
import dotenv from 'dotenv';

dotenv.config();

const router = Router();
router.use(auth);

// Cashfree configuration
const CASHFREE_CONFIG = {
  APP_ID: process.env.CASHFREE_APP_ID,
  SECRET_KEY: process.env.CASHFREE_SECRET_KEY,
  ENV: process.env.CASHFREE_ENV || 'SANDBOX',
  API_VERSION: '2022-09-01'
};

const getCashfreeHeaders = () => ({
  'Content-Type': 'application/json',
  'x-client-id': CASHFREE_CONFIG.APP_ID,
  'x-client-secret': CASHFREE_CONFIG.SECRET_KEY,
  'x-api-version': CASHFREE_CONFIG.API_VERSION
});

const getCashfreeBaseUrl = () => 
  CASHFREE_CONFIG.ENV === 'PRODUCTION' 
    ? 'https://api.cashfree.com/pg' 
    : 'https://sandbox.cashfree.com/pg';


// Create new order
router.post(
  '/create',
  handler(async (req, res) => {
    const order = req.body;

    if (!order.items?.length) {
      return res.status(BAD_REQUEST).send('Cart Is Empty!');
    }

    // Validate prices and sizes
    for (const item of order.items) {
      const product = await FoodModel.findById(item.product);
      if (!product) return res.status(BAD_REQUEST).send('Invalid product in cart!');
      const quantityObj = product.quantities.find(q => q.size === item.size);
      if (!quantityObj) return res.status(BAD_REQUEST).send('Invalid size for product!');
      if (quantityObj.price !== item.price) return res.status(BAD_REQUEST).send('Price mismatch!');
    }

    order.items = order.items.filter(item => item.product);
    if (order.items.length === 0) {
      return res.status(BAD_REQUEST).send('No valid products in cart!');
    }

    const newOrder = new OrderModel({ ...order, user: req.user.id });
    await newOrder.save();

    res.send(newOrder);
  })
);
router.post(
  '/create-cashfree-order',
  handler(async (req, res) => {
    try {
      const { orderId, orderAmount } = req.body;
      if (!orderId || !orderAmount) {
        return res.status(400).json({ error: 'orderId and orderAmount are required' });
      }

      // Build orderData (your existing logic here)
      const orderData = {
        order_id: `order_${orderId}_${Date.now()}`,
        order_amount: orderAmount,
        order_currency: 'INR',
        customer_details: {
          customer_id: `cust_${req.user.phone || Date.now()}`,
          customer_email: req.user.email || 'noemail@example.com',
          customer_phone: req.user.phone || '9999999999',
        },
        order_meta: {
          return_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/order-status?order_id=${orderId}`,
        },
      };

      // Use helper function to get base URL depending on env
      const baseUrl = getCashfreeBaseUrl();

      console.log("Calling Cashfree API at:", baseUrl);
      console.log("Using headers:", getCashfreeHeaders());
      console.log("Order data sent to Cashfree:", orderData);

      // Axios call to Cashfree API
      const response = await axios.post(
        `${baseUrl}/orders`,
        orderData,
        { headers: getCashfreeHeaders() }
      );

      console.log("Cashfree response data:", response.data);

      console.log("Raw payment_session_id from Cashfree:", response.data.payment_session_id);
const cleanSessionId = response.data.payment_session_id.replace(/payment+$/i, ''); // removes trailing repeated 'payment'
console.log("Cleaned payment_session_id:", cleanSessionId);

return res.json({
  payment_session_id: cleanSessionId,
  order_id: response.data.order_id,
});


    } catch (error) {
      console.error('Cashfree error:', {
        message: error.message,
        response: error.response?.data,
      });

      return res.status(500).json({
        error: 'Payment processing failed',
        details: error.response?.data?.message || error.message,
      });
    }
  })
);

// Payment completion
router.put(
  '/pay',
  handler(async (req, res) => {
    const { paymentId, method = 'Cashfree', status = 'COMPLETED' } = req.body;

    const order = await getNewOrderForCurrentUser(req);
    if (!order) return res.status(BAD_REQUEST).send('Order Not Found!');

    const payment = new PaymentModel({
      order: order._id,
      user: req.user.id,
      paymentId,
      method,
      amount: order.totalPrice,
      status,
    });
    await payment.save();

    if (status === 'COMPLETED') {
      order.paymentId = paymentId;
      order.status = OrderStatus.PAYED;
      await order.save();
      await sendEmailReceipt(order);
    }

    res.send({
      orderId: order._id,
      paymentId: payment._id,
      paymentStatus: status,
    });
  })
);

// Track order
router.get(
  '/track/:orderId',
  handler(async (req, res) => {
    const { orderId } = req.params;
    const user = await UserModel.findById(req.user.id);

    const filter = { _id: orderId };
    if (!user.isAdmin) filter.user = user._id;

    const order = await OrderModel.findOne(filter).populate('items.product');
    if (!order) return res.send(UNAUTHORIZED);

    res.send(order);
  })
);


// ✅ Delete order
router.delete('/:id', async (req, res) => {
  try {
    const deletedOrder = await OrderModel.findByIdAndDelete(req.params.id);
    if (!deletedOrder) {
      return res.status(404).json({ message: 'Order not found' });
    }
    res.json({ message: 'Order deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ✅ New order for current user
router.get('/newOrderForCurrentUser', async (req, res) => {
  try {
    const order = await OrderModel.findOne({
      user: req.user.id,
      status: OrderStatus.NEW,
    })
      .populate('user')
      .populate({
        path: 'items.product',
        select: 'name images quantities',
      });

    if (!order) return res.status(404).send({ message: 'No active order found' });

    res.send(order);
  } catch (err) {
    console.error('Error in newOrderForCurrentUser:', err);
    res.status(500).send({ error: err.message });
  }
});

// ✅ All statuses
router.get('/allstatus', (req, res) => {
  res.send(Object.values(OrderStatus));
});

// ✅ Orders by status
router.get('/:status?', handler(async (req, res) => {
  const status = req.params.status;
  const user = await UserModel.findById(req.user.id);
  const filter = {};

  if (!user.isAdmin) filter.user = user._id;
  if (status) filter.status = status;

  const orders = await OrderModel.find(filter)
    .populate('items.product')
    .sort('-createdAt');

  res.send(orders);
}));

// ✅ Admin orders
router.get('/orders', admin, handler(async (req, res) => {
  const { user, status, from, to } = req.query;
  const filter = {};
  if (user) filter.user = user;
  if (status) filter.status = status;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }
  const orders = await OrderModel.find(filter)
    .populate('items.product')
    .populate('user')
    .populate({ path: 'payment', select: 'status' })
    .sort('-createdAt');

  res.json(orders);
}));

// ✅ Update order status
router.patch('/order/:id/status', admin, handler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const order = await OrderModel.findByIdAndUpdate(id, { status }, { new: true });
  if (!order) return res.status(404).json({ message: 'Order not found' });
  res.json(order);
}));

// ✅ Update payment status
router.patch('/payment/:id/status', admin, handler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const payment = await PaymentModel.findByIdAndUpdate(id, { status }, { new: true });
  if (!payment) return res.status(404).json({ message: 'Payment not found' });

  if (status === 'COMPLETED') {
    const order = await OrderModel.findById(payment.order);
    if (order && order.status !== OrderStatus.PAYED) {
      order.status = OrderStatus.PAYED;
      order.paymentId = payment.paymentId;
      await order.save();
    }
  }
  res.json(payment);
}));

// ✅ User purchase count
router.get('/user-purchase-count', async (req, res) => {
  try {
    const count = await OrderModel.countDocuments({ user: req.user.id, status: 'PAYED' });
    res.json({ count });
  } catch (err) {
    console.error('Error in user-purchase-count:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// ✅ Get single order
router.get('/order/:id', handler(async (req, res) => {
  const order = await OrderModel.findById(req.params.id).populate('items.product');
  if (!order) return res.status(404).json({ message: 'Order not found' });
  res.json(order);
}));

// Helper
const getNewOrderForCurrentUser = async req =>
  await OrderModel.findOne({
    user: req.user.id,
    status: OrderStatus.NEW,
  })
    .sort({ createdAt: -1 })
    .populate('user');

export default router;