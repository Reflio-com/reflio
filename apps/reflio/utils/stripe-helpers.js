import { supabaseAdmin } from './supabase-admin';
import { stripe } from './stripe';
import { invoicePayment, chargePayment } from './stripe-payment-helpers';
import { monthsBetweenDates } from './helpers';

export const createCommission = async(referralData, stripeId, referralId, email) => {
  const customer = await stripe.customers.list({
    email: email,
    limit: 1,
  }, {
    stripeAccount: stripeId
  });

  //Payment intent flow
  if(customer?.data?.length){
    await stripe.customers.update(
      customer?.data[0]?.id,
      {metadata: {reflio_referral_id: referralData?.data?.referral_id}},
      {stripeAccount: stripeId}
    );

    if(customer?.data[0]?.email === email){
      const paymentIntent = await stripe.paymentIntents.list({
        customer: customer?.data[0]?.id,
        limit: 1,
      }, {
        stripeAccount: stripeId
      });

      if(paymentIntent?.data?.length && paymentIntent?.data[0]?.metadata?.reflio_commission_id){
        //Check DB and make sure that the commission is still valid and exists.
        let commissionFromId = await supabaseAdmin
          .from('commissions')
          .select('commission_id, paid_at')
          .eq('commission_id', paymentIntent?.data[0]?.metadata?.reflio_commission_id)
          .single();

        if(commissionFromId?.data !== null){
          return "commission_exists"
        }
      }

      if(paymentIntent?.data[0]?.invoice){
        await invoicePayment(referralData, stripeId, referralId, paymentIntent, null);
        return "success";

      } else if(paymentIntent?.data[0]?.charges){
        await chargePayment(referralData, stripeId, referralId, paymentIntent);
        return "success";

      } else {
        return "commission_payment_calculation_error";
      }
    }
  }

  return "error";
};

export const editCommission = async(data) => {
  let paymentData = data?.data?.object ? data?.data?.object : null;

  if(paymentData === null){
    return "error";
  }
   
  const paymentIntent = await stripe.paymentIntents.retrieve(
    paymentData?.payment_intent,
    {stripeAccount: data?.account}
  );

  if(paymentIntent?.metadata?.reflio_commission_id){
    let commissionFromId = await supabaseAdmin
      .from('commissions')
      .select('referral_id')
      .eq('commission_id', paymentIntent?.metadata?.reflio_commission_id)
      .single();

    if(commissionFromId?.data !== null){
      let referralFromId = await supabaseAdmin
        .from('referrals')
        .select('commission_value', 'commission_type')
        .eq('referral_id', commissionFromId?.data?.referral_id)
        .single();

      if(referralFromId?.data !== null){
        let paymentIntentTotal = paymentData?.amount;

          //----CALCULATE REUNDS----
          const refunds = await stripe.refunds.list({
            payment_intent: paymentData?.payment_intent,
            limit: 100,
          }, {
            stripeAccount: data?.account
          });
  
          if(refunds && refunds?.data?.length > 0){
            refunds?.data?.map(refund => {
              if(refund?.amount > 0){
                paymentIntentTotal = parseInt(paymentIntentTotal - refund?.amount);
              }
            })
          }
          //----END CALCULATE REUNDS----
  
          let commissionAmount = paymentIntentTotal > 0 ? referralFromId?.data?.commission_type === "fixed" ? referralFromId?.data?.commission_value : (parseInt((((parseFloat(paymentIntentTotal/100)*parseFloat(referralFromId?.data?.commission_value))/100)*100))) : 0;

          const { error } = await supabaseAdmin
            .from('commissions')
            .update({
              commission_sale_value: paymentIntentTotal,
              commission_total: commissionAmount
            })
            .eq('commission_id', paymentIntent?.metadata?.reflio_commission_id);

          if (error) return "error";

          return "success";
      }
    }
  }

  return "error";
};

export const findCommission = async(data) => {
  let paymentData = data?.data?.object ? data?.data?.object : null;
  
  if(paymentData === null){
    return "error";
  }

  if(!paymentData?.payment_intent){
    return "no payment intent";
  }

  if(!paymentData?.customer){
    return "no customer";
  }

  const customer = await stripe.customers.retrieve(
    paymentData?.customer,
    {stripeAccount: data?.account}
  );

  if(customer?.metadata?.reflio_referral_id){
    let referralFromId = await supabaseAdmin
      .from('referrals')
      .select('*')
      .eq('referral_id', customer?.metadata?.reflio_referral_id)
      .single();

    if(referralFromId?.data !== null){
      let earliestCommission = await supabaseAdmin
        .from('commissions')
        .select('created')
        .eq('referral_id', referralFromId?.data?.referral_id)
        .order('created', { ascending: true })
        .limit(1)

        if(earliestCommission?.data !== null){
          let commissionFound = earliestCommission?.data[0];

          if(commissionFound?.created){
            let stripeDateConverted = new Date(paymentData?.created * 1000);
            let earliestCommissionDate = new Date(commissionFound?.created);
            let monthsBetween = monthsBetweenDates(stripeDateConverted, earliestCommissionDate);

            if(referralFromId?.data?.commission_period > monthsBetween){
              if(paymentData?.invoice){
                await invoicePayment(referralFromId, data?.account, referralFromId?.data?.referral_id, null, paymentData?.invoice);
                return "success";
              }
            }
          }
        }
    }
  }

  return "error";

}

//Deletes stripe ID from company account
export const deleteIntegrationFromDB = async (stripeId) => {
  const { error } = await supabaseAdmin
  .from('companies')
  .update({
    stripe_id: null
  })
  .eq({ stripe_id: stripeId })
  if (error) return "error";
};